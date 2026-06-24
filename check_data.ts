import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const qDoc = await getDoc(doc(db, 'sync', 'tkd_bout_queue'));
  if (qDoc.exists()) {
    const data = qDoc.data().value;
    const byEvent = data.reduce((acc, item) => {
       const eid = item.data?.eventId || 'none';
       acc[eid] = (acc[eid] || 0) + 1;
       return acc;
    }, {});
    console.log("Queue counts:", byEvent);

    const matchSnap = await getDoc(doc(db, 'sync', 'tkd_match_history'));
    console.log("Match history:", matchSnap.exists() ? "Exists" : "Not Found");
  }
  process.exit(0);
}
run();
