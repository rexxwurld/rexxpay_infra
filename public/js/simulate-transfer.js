    const form = document.getElementById('simulateForm');
    const button = document.getElementById('payButton');
    const statusBox = document.getElementById('status');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const accountNumber =
        document.getElementById('accountNumber').value.trim();

      const amountNaira =
        Number(document.getElementById('amount').value);

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
        const response = await fetch(
          '/api/mock-bank/simulate-transfer',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              accountNumber,
              amount,
              currency: 'NGN'
            })
          }
        );

        let data;

        try {
          data = await response.json();
        } catch {
          throw new Error(
            `Server returned HTTP ${response.status}.`
          );
        }

        if (!response.ok || !data.status) {
          throw new Error(
            data.message ||
            `Simulation failed (HTTP ${response.status}).`
          );
        }

        showSuccess(
          '✅ Simulated payment sent successfully. ' +
          'Wait a few seconds, then check the checkout.'
        );

        button.textContent = 'Payment Simulated';

      } catch (error) {
        showError(error.message || 'Unable to simulate payment.');
        button.textContent = 'Simulate Payment';
      } finally {
        button.disabled = false;
      }
    });

    function showSuccess(message) {
      statusBox.className = 'status success';
      statusBox.textContent = message;
    }

    function showError(message) {
      statusBox.className = 'status error';
      statusBox.textContent = '❌ ' + message;
    }
