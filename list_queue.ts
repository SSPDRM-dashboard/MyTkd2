import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const qDoc = await getDoc(doc(db, 'sync', 'tkd_bout_queue'));
  if (qDoc.exists()) {
    let data = qDoc.data().value;
    console.log("Queue size:", data.length);
    console.log("Queue items:");
    for (const d of data) {
      console.log(d.data.bout + " " + d.data.blue_name);
    }
  }
  process.exit(0);
}
run();
