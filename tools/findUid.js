// Find Firebase UID by email using Firebase Admin
// Usage: node api/tools/findUid.js --email=<EMAIL>

const admin = require('firebase-admin');

async function initAdmin() {
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
  }
}

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const email = args.email;
  if (!email) {
    console.error('Usage: node api/tools/findUid.js --email=<EMAIL>');
    process.exit(1);
  }
  await initAdmin();
  const user = await admin.auth().getUserByEmail(email);
  console.log(JSON.stringify({ email: user.email, uid: user.uid }, null, 2));
}

main().catch((e) => {
  console.error('findUid error:', e.message);
  process.exit(1);
});