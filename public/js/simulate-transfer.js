const form = document.getElementById('simulateForm');
const button = document.getElementById('payButton');
const statusBox = document.getElementById('status');

function showSuccess(message) {
  statusBox.className = 'status success';
  statusBox.textContent = message;
}

function showError(message) {
  statusBox.className = 'status error';
  statusBox.textContent = '❌ ' + message;
}

function showPending(message) {
  statusBox.className = 'status success';
  statusBox.textContent = '⏳ ' + message;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls the webhook event's real processing outcome instead of trusting
// the initial POST's 202, which only means "queued", not "succeeded".
async function pollOutcome(eventId) {
  const maxAttempts = 30;
  const delayMs = 1000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(delayMs);

    let res, data;
    try {
      res = await fetch(`/api/mock-bank/simulate-transfer/${eventId}/status`);
      data = await res.json();
    } catch {
      continue; // transient network hiccup - just try again
    }

    if (!res.ok || !data.status) continue;

    const { eventStatus, lastError, transactionStatus, flagReason } = data.data;

    if (eventStatus === 'failed') {
      showError(`Webhook processing failed: ${(lastError || 'unknown error').replace(/_/g, ' ')}.`);
      return;
    }

    if (eventStatus === 'processed') {
      if (transactionStatus === 'success' || transactionStatus === 'over') {
        showSuccess(`✅ Payment confirmed (${transactionStatus}). Check the checkout page — it should now show as paid.`);
      } else if (transactionStatus === 'flagged') {
        showError(`Payment landed but was flagged for review${flagReason ? ` (${flagReason.replace(/_/g, ' ')})` : ''}. It will not credit the wallet until cleared.`);
      } else if (transactionStatus === 'partial') {
        showPending('Payment received but was less than the amount expected (partial).');
      } else if (transactionStatus === 'failed') {
        showError('Payment processing failed.');
      } else {
        showSuccess('Webhook processed.');
      }
      return;
    }

    // still 'queued' or 'processing' - keep polling
    showPending(`Processing (attempt ${attempt + 1}/${maxAttempts})…`);
  }

  showError('Timed out waiting for the outcome — check the checkout page directly, or look at the audit log.');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const accountNumber = document.getElementById('accountNumber').value.trim();
  const amountNaira = Number(document.getElementById('amount').value);

  statusBox.className = 'status';
  statusBox.textContent = '';

  if (!accountNumber) {
    showError('Enter the account number shown on the checkout.');
    return;
  }

  if (!Number.isFinite(amountNaira) || amountNaira <= 0) {
    showError('Enter a valid amount.');
    return;
  }

  // Your backend expects minor units (kobo).
  const amount = Math.round(amountNaira * 100);

  button.disabled = true;
  button.textContent = 'Processing...';

  try {
    const response = await fetch('/api/mock-bank/simulate-transfer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountNumber, amount, currency: 'NGN' }),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`Server returned HTTP ${response.status}.`);
    }

    if (!response.ok || !data.status) {
      throw new Error(data.message || `Simulation failed (HTTP ${response.status}).`);
    }

    const eventId = data.rexpayResponse?.webhookResponse?.eventId;
    if (!eventId) {
      // Fallback: we don't have an event to poll, so we can't confirm the
      // real outcome - be honest about that instead of claiming success.
      showPending('Webhook sent, but no event ID was returned to track the outcome. Check the checkout page manually.');
      return;
    }

    showPending('Webhook sent — waiting for it to actually process…');
    button.textContent = 'Waiting for outcome…';
    await pollOutcome(eventId);
    button.textContent = 'Simulate Payment';

  } catch (error) {
    showError(error.message || 'Unable to simulate payment.');
    button.textContent = 'Simulate Payment';
  } finally {
    button.disabled = false;
  }
});
