import { initializeApp } from 'firebase/app';
import { getFirestore, getDocs, collection } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const snap = await getDocs(collection(db, 'tkd_bout_queue'));
  const counts = {};
  snap.forEach(d => {
    const data = d.data();
    counts[data.data.eventId] = (counts[data.data.eventId] || 0) + 1;
  });
  console.log(counts);
  process.exit(0);
}
run();
