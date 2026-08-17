// send-wave-state — manually drive the wave-state feed for visual testing
// without sending a real message. POSTs directly to the shell's bridge
// listener (/turn-state), which broadcasts dsh-wave-state to the main window.
//
//   node scripts/send-wave-state.mjs calm                     # one state
//   node scripts/send-wave-state.mjs thinking streaming tooling settle   # sequence
//   node scripts/send-wave-state.mjs --auto                    # cycle all 7
//
// States: calm | thinking | streaming | tooling | waiting | error | settle

const PORT = 38657;
const STATES = ['calm', 'thinking', 'streaming', 'tooling', 'waiting', 'error', 'settle'];
const GAP_MS = 2600;

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/send-wave-state.mjs <state...|--auto>');
  process.exit(2);
}

async function post(state) {
  if (!STATES.includes(state)) {
    console.error(`✗ unknown state "${state}" (valid: ${STATES.join('|')})`);
    process.exit(2);
  }
  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/turn-state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, detail: 'manual-test' }),
    });
    console.log(`→ ${state.padEnd(9)} ${resp.ok ? 'OK' : `HTTP ${resp.status}`}`);
  } catch (e) {
    console.error(`✗ ${state}: ${e.message} (is the app running?)`);
    process.exit(1);
  }
}

if (args[0] === '--auto') {
  let i = 0;
  const loop = () => {
    post(STATES[i % STATES.length]);
    i += 1;
    if (i < STATES.length * 2) setTimeout(loop, GAP_MS);
  };
  loop();
} else {
  (async () => {
    for (const state of args) {
      await post(state);
      await new Promise((r) => setTimeout(r, 700));
    }
    console.log('done — check dsh.log for "wave state:" lines');
  })();
}
