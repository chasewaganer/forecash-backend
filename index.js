import express from 'express';
import bodyParser from 'body-parser';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { createClient } from '@supabase/supabase-js';

const app = express();
app.use(bodyParser.json());

const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments.sandbox,
  baseOptions: { headers: {
    'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
    'PLAID-SECRET': process.env.PLAID_SECRET,
  }}
}));

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 1️⃣ Link token
app.post('/create_link_token', async (req, res) => {
  const { user_id } = req.body;
  try {
    const response = await plaid.linkTokenCreate({
      user: { client_user_id: user_id },
      client_name: 'CashFlowApp',
      products: ['auth', 'transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2️⃣ Exchange tokens
app.post('/get_access_token', async (req, res) => {
  const { public_token, user_id } = req.body;
  try {
    const tokenResp = await plaid.itemPublicTokenExchange({ public_token });
    const access_token = tokenResp.data.access_token;
    const insert = await sb
      .from('accounts')
      .insert({ user_id, plaid_id: access_token })
      .select();
    res.json({ access_token, account: insert.data[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 3️⃣ Sync balances
app.post('/sync_accounts', async (req, res) => {
  const { user_id } = req.body;
  const { data } = await sb
    .from('accounts')
    .select('id,plaid_id')
    .eq('user_id', user_id);
  if (!data.length) return res.status(404).json({ error: 'no accounts found' });

  const updates = [];
  for (const acc of data) {
    const acctResp = await plaid.accountsGet({ access_token: acc.plaid_id });
    const pb = acctResp.data.accounts[0]?.balances || {};
    updates.push(
      sb.from('accounts')
        .update({ balance: pb.current ?? 0 })
        .eq('id', acc.id)
    );
  }
  await Promise.all(updates);
  res.json({ success: true });
});

// 4️⃣ Sync transactions
app.post('/sync_transactions', async (req, res) => {
  const { user_id, start_date, end_date } = req.body;
  const { data } = await sb
    .from('accounts')
    .select('id,plaid_id')
    .eq('user_id', user_id);

  let count = 0;
  for (const acc of data) {
    const txResp = await plaid.transactionsGet({
      access_token: acc.plaid_id,
      start_date,
      end_date,
    });
    for (const tx of txResp.data.transactions) {
      await sb.from('actual_transactions').insert({
        user_id,
        account_id: acc.id,
        description: tx.name,
        amount: tx.amount,
        date: tx.date,
        source: 'plaid',
      });
      count++;
    }
  }
  res.json({ transactions: count });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`App running on port ${port}`));
