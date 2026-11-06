const demoButton = document.querySelector('#demo-toggle');
const conversation = document.querySelector('#conversation');
const result = document.querySelector('#demo-result');
if (demoButton && conversation && result) {
  demoButton.hidden = false;
  demoButton.addEventListener('click', () => {
    const showingResult = !result.hidden;
    result.hidden = showingResult;
    conversation.hidden = !showingResult;
    document.querySelector('.demo-proof').hidden = !showingResult;
    demoButton.textContent = showingResult ? 'See the update →' : 'Replay example ↺';
  });
}
const copyButton = document.querySelector('#copy-button');
const copyStatus = document.querySelector('#copy-status');
const commands = document.querySelector('#commands');
if (copyButton && copyStatus && commands) {
  copyButton.hidden = false;
  copyButton.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(commands.textContent);
      copyStatus.textContent = 'Commands copied.';
    } catch {
      copyStatus.textContent = 'Could not copy automatically. Select the commands above and copy them manually.';
    }
  });
}
