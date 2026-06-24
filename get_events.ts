import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const eDoc = await getDoc(doc(db, 'sync', 'tkd_events_v3'));
  console.log("Events:", eDoc.exists() ? eDoc.data().value : "None");
  process.exit(0);
}
run();
