import { initializeApp } from 'firebase/app';
import { getFirestore, getDocs, collection, deleteDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const snap = await getDocs(collection(db, 'matchHistory'));
  let deleted = 0;
  for (const d of snap.docs) {
    const data = d.data();
    if (data.eventId === '9brq95mpp') {
       await deleteDoc(doc(db, 'matchHistory', d.id));
       deleted++;
    }
  }
  console.log(`Deleted ${deleted} corrupted history items from DAY2ONLY.`);
  process.exit(0);
}
run();
