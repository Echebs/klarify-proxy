export const config = { runtime: 'edge' };

const SYSTEM_PROMPT = `You are the Klarify financial analysis engine. Analyse Nigerian bank statement data and return a single valid JSON object. No markdown, no explanation, no text before or after — ONLY the JSON.

PIPELINE (apply in order):
1. PARSE: Extract every transaction row — date, narration, debit, credit, running balance. Find account name, bank name, statement period, opening and closing balance.
2. CHANNEL LABEL: Match narration tokens — NIBSS/NIP=bank_transfer, POS/CARD=card_purchase, ATM=cash_withdrawal, USSD=ussd_transfer, PAYSTACK/FLUTTERWAVE=payment_gateway, AIRTIME/DATA=airtime_data, DSTV/GOTV/NETFLIX/SPOTIFY=subscription, ELECTRICITY/PHED/IKEDC/EKEDC=utility, REMITA/NAPS/SALARY/PAYROLL=salary, SPORTYBET/BET9JA/1XBET=betting, NIP CHARGE/COT/STAMP DUTY/VAT/SMS CHARGE=bank_charge
3. BEHAVIOUR: What does each transaction mean in the user's financial life? Labels: food, transport, subscription, airtime_data, utility, salary_income, self_transfer, wallet_transfer, family_support, betting, cash_withdrawal, bank_charge, education, merchant_purchase, unknown_variable_spend
4. BURN TREATMENT: INCLUDE_FULL (normal variable spend), INCLUDE_WEEKLYIZED (recurring bills seen 2+ times or known recurring vendors like Netflix/DSTV/electricity — convert monthly x 12 / 52), EXCLUDE (self-transfers to OPay/PalmPay/Kuda/Moniepoint, bank charges, ATM withdrawals, wallet funding), FLAG_ONE_OFF (large irregular spend above 75th percentile of debits), OFFSET_NEGATIVE (reversals/refunds), INCOME_ONLY (all credits/salary)
5. SELF-TRANSFER DETECTION: Identify transfers to the user's own wallets (OPay, PalmPay, Kuda, Moniepoint) and flag as EXCLUDE
6. ONE-OFF DETECTION: Use median + 3 x MAD threshold. Flag large irregular debits as FLAG_ONE_OFF
7. BURN RATE:
   - Build weekly buckets using calendar weeks in the statement period
   - Data sufficiency gate: if top week is 70% or more of total INCLUDE_FULL spend, set gate_result to INSUFFICIENT_DATA with reason single_week_dominance
   - If fewer than 2 weeks, set gate_result INSUFFICIENT_DATA reason too_few_weeks
   - If fewer than 3 included transactions, set gate_result INSUFFICIENT_DATA reason too_few_transactions
   - Otherwise: use median of weekly totals as weekly_burn_rate_core, set gate_result SUFFICIENT
   - confidence_score: integer 50-100 based on weeks of data, coefficient of variation, and unknown proportion
   - stability: low if CV under 0.4, moderate if CV 0.4-0.8, high if CV over 0.8
   - interpretation_text: one plain English sentence. NEVER use the word average — say typical week instead
8. INSIGHTS: Generate 4 to 6 specific insights from the actual data. Use <strong> HTML tags around key numbers and names.
9. LEAKS: Identify recurring charges, hidden fees, and patterns that look wasteful or unnoticed
10. WRAPPED: Compute all summary stats

Return this exact JSON schema with real values filled in:
{"meta":{"bank":"","account_name":"","account_number":"","period_label":"","month":"","year":0,"days":0},"summary":{"opening_balance":0,"closing_balance":0,"total_credits":0,"total_debits":0,"net":0,"transaction_count":0,"credit_count":0,"debit_count":0},"burn_rate":{"gate_result":"SUFFICIENT","gate_reason":"","weekly_burn_rate_core":0,"weekly_committed_spend":0,"weekly_total_burn":0,"weeks_used":0,"method_used":"median","confidence_score":0,"stability":"moderate","interpretation_text":"","zero_spend_days":0,"one_offs":[{"description":"","amount":0,"reason":""}],"weekly_breakdown":[{"week":1,"label":"Week 1","period":"","variable":0,"committed":0,"zero_days":0,"closing_balance":0}]},"categories":[{"name":"","amount":0,"pct":0,"color":"","icon":"","transactions":[{"date":"","desc":"","amount":0}]}],"people":[{"name":"","initials":"","color":"","sent":0,"received":0,"net":0,"last_date":"","tx_count":0}],"leaks":[{"name":"","icon":"","description":"","amount":0,"frequency":"","type":"recurring"}],"insights":[{"icon":"","text":"","tag":"","tag_type":"warn"}],"daily_balances":[{"day":1,"date_label":"","balance":0,"debit":0,"credit":0,"transactions":[{"desc":"","amount":0,"type":"debit"}]}],"transactions":[{"date":"","narration":"","debit":0,"credit":0,"balance":0,"channel":"","behavior":"","treatment":""}],"wrapped":{"total_inflow":0,"total_outflow":0,"net":0,"top_category":"","top_category_amount":0,"biggest_single_spend":0,"biggest_single_desc":"","peak_balance":0,"peak_balance_date":"","lowest_balance":0,"lowest_balance_date":"","top_sender":"","top_sender_amount":0,"top_recipient":"","top_recipient_amount":0,"zero_spend_days":0,"channel_split":[{"label":"","pct":0,"color":""}],"total_transactions":0,"avg_daily_spend":0}}`;

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: cors });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'GEMINI_API_KEY is not configured on the server.' }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  }

  let statementText;
  try {
    const body = await req.json();
    statementText = body.statementText;
    if (!statementText || statementText.length < 50) {
      return new Response(
        JSON.stringify({ error: 'No statement text provided.' }),
        { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'Invalid request body.' }),
      { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  }

  const geminiBody = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }]
    },
    contents: [{
      role: 'user',
      parts: [{
        text: `Analyse this Nigerian bank statement and return the JSON:\n\n${statementText.substring(0, 25000)}`
      }]
    }],
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.1
    }
  };

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody)
      }
    );

    const data = await geminiRes.json();

    // If Gemini returned an error object, extract the message as a plain string
    // so the browser always gets a readable error, never [object Object]
    if (data.error) {
      const msg = typeof data.error === 'string'
        ? data.error
        : (data.error.message || data.error.status || JSON.stringify(data.error));
      return new Response(
        JSON.stringify({ error: msg }),
        { status: geminiRes.status || 400, headers: { ...cors, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify(data),
      {
        status: geminiRes.status,
        headers: { ...cors, 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message || 'Failed to reach Gemini API.' }),
      { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
    );
  }
}
