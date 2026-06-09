(function createSiyaqApi() {
  const { createClient } = window.supabase;
  const {
  AI_PROXY_TIMEOUT_MS,
  AI_PROXY_URL,
  CUSTOMER_QUERY_LIMIT,
  INTERACTION_QUERY_LIMIT,
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
  } = window.SIYAQ_CONFIG;

const CUSTOMER_COLUMNS = 'id,name,phone,init,report,report_updated_at';
const INTERACTION_COLUMNS = 'id,customer_id,channel,date,summary,status,email';
const RPC_NAME = 'add_customer_interaction';

const supabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
);

function throwIfError(error, operation) {
  if (!error) return;
  const wrapped = new Error(`${operation}: ${error.message || 'Supabase request failed'}`);
  wrapped.name = 'SupabaseRequestError';
  wrapped.code = error.code;
  wrapped.details = error.details;
  wrapped.hint = error.hint;
  wrapped.cause = error;
  throw wrapped;
}

function isMissingRpcError(error) {
  const code = String(error?.code || '');
  const message = `${error?.message || ''} ${error?.details || ''}`.toLowerCase();
  return (
    code === 'PGRST202'
    || code === '42883'
    || message.includes('could not find the function')
    || message.includes('function public.add_customer_interaction')
    || message.includes('does not exist')
  );
}

function isUniqueViolation(error) {
  return String(error?.code || '') === '23505';
}

function firstRpcRow(data) {
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

function rpcCustomerId(data) {
  const row = firstRpcRow(data);
  if (typeof row === 'string' || typeof row === 'number') return String(row);
  return row?.customer_id || row?.id || null;
}

async function loadCustomerRecords() {
  const [customersResult, interactionsResult] = await Promise.all([
    supabaseClient
      .from('customers')
      .select(CUSTOMER_COLUMNS)
      .order('name', { ascending: true })
      .limit(CUSTOMER_QUERY_LIMIT),
    supabaseClient
      .from('interactions')
      .select(INTERACTION_COLUMNS)
      .order('date', { ascending: false })
      .limit(INTERACTION_QUERY_LIMIT),
  ]);

  throwIfError(customersResult.error, 'Load customers');
  throwIfError(interactionsResult.error, 'Load interactions');

  const interactionsByCustomer = new Map();
  for (const interaction of interactionsResult.data || []) {
    const customerInteractions = interactionsByCustomer.get(interaction.customer_id);
    if (customerInteractions) customerInteractions.push(interaction);
    else interactionsByCustomer.set(interaction.customer_id, [interaction]);
  }
  for (const customerInteractions of interactionsByCustomer.values()) {
    customerInteractions.sort((left, right) => (
      String(left.date).localeCompare(String(right.date))
    ));
  }

  return (customersResult.data || []).map((customer) => ({
    ...customer,
    ints: interactionsByCustomer.get(customer.id) || [],
  }));
}

async function addCustomerInteractionFallback(input) {
  const lookup = await supabaseClient
    .from('customers')
    .select('id')
    .eq('phone', input.phone)
    .limit(1);
  throwIfError(lookup.error, 'Find customer by phone');

  let customerId = lookup.data?.[0]?.id;
  let createdCustomer = false;

  if (!customerId) {
    const insertedCustomer = await supabaseClient
      .from('customers')
      .insert({
        name: input.name,
        phone: input.phone,
        init: input.name.slice(0, 2),
      })
      .select('id')
      .single();

    if (isUniqueViolation(insertedCustomer.error)) {
      const concurrentLookup = await supabaseClient
        .from('customers')
        .select('id')
        .eq('phone', input.phone)
        .limit(1);
      throwIfError(concurrentLookup.error, 'Find concurrently created customer');
      customerId = concurrentLookup.data?.[0]?.id;
    } else {
      throwIfError(insertedCustomer.error, 'Create customer');
      customerId = insertedCustomer.data?.id;
      createdCustomer = true;
    }
  }

  if (!customerId) throw new Error('Create customer: no customer id returned');

  const insertedInteraction = await supabaseClient
    .from('interactions')
    .insert({
      customer_id: customerId,
      channel: input.channel,
      date: input.date,
      summary: input.summary,
      status: input.status,
      email: input.email,
    })
    .select('id,customer_id')
    .single();
  throwIfError(insertedInteraction.error, 'Create interaction');

  const invalidatedReport = await supabaseClient
    .from('customers')
    .update({ report: null, report_updated_at: null })
    .eq('id', customerId)
    .select('id')
    .single();

  return {
    customerId,
    interactionId: insertedInteraction.data?.id || null,
    usedRpc: false,
    createdCustomer,
    reportInvalidationError: invalidatedReport.error || null,
  };
}

async function addCustomerInteraction(input) {
  const rpcResult = await supabaseClient.rpc(RPC_NAME, {
    p_name: input.name,
    p_phone: input.phone,
    p_channel: input.channel,
    p_date: input.date,
    p_summary: input.summary,
    p_status: input.status,
    p_email: input.email,
  });

  if (!rpcResult.error) {
    return {
      customerId: rpcCustomerId(rpcResult.data),
      interactionId: firstRpcRow(rpcResult.data)?.interaction_id || null,
      usedRpc: true,
      createdCustomer: Boolean(firstRpcRow(rpcResult.data)?.created_customer),
      reportInvalidationError: null,
    };
  }

  if (!isMissingRpcError(rpcResult.error)) {
    throwIfError(rpcResult.error, 'Add customer interaction');
  }

  return addCustomerInteractionFallback(input);
}

async function saveCustomerReport(customerId, report, updatedAt, signal) {
  let query = supabaseClient
    .from('customers')
    .update({
      report: JSON.stringify(report),
      report_updated_at: updatedAt,
    })
    .eq('id', customerId)
    .select('id,report,report_updated_at');
  if (signal) query = query.abortSignal(signal);
  const result = await query.single();
  if (signal?.aborted) throw new DOMException('Report request aborted', 'AbortError');
  throwIfError(result.error, 'Save customer report');
  return result.data;
}

async function requestAiReport(payload, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AI_PROXY_TIMEOUT_MS);

  try {
    const response = await fetch(AI_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`AI proxy responded with ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      if (!timedOut && signal?.aborted) throw error;
      throw new Error('AI proxy request timed out', { cause: error });
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

window.SiyaqApi = Object.freeze({
  addCustomerInteraction,
  loadCustomerRecords,
  requestAiReport,
  saveCustomerReport,
});
}());
