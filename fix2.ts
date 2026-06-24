import { initializeApp } from 'firebase/app';
import { getFirestore, getDocs, collection, setDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const snap = await getDocs(collection(db, 'matchHistory'));
  let count = 0;
  for (const d of snap.docs) {
    if (!d.data().eventId) {
      await setDoc(doc(db, 'matchHistory', d.id), { eventId: 'o6nsg2u9k' }, { merge: true });
      count++;
    }
  }
  console.log("Fixed " + count + " empty eventIds.");
  process.exit(0);
}
run();
