import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, setDoc, doc, collection, getDocs } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const snap = await getDocs(collection(db, 'matchHistory'));
  for (const d of snap.docs) {
    if (d.data().eventId === 'o6nsg2u9k' || d.data().eventId === undefined) {
      await setDoc(doc(db, 'matchHistory', d.id), { eventId: '6a3gvhnei' }, { merge: true });
    }
  }
  console.log("Updated matchHistory Event ID to 6a3gvhnei");
  process.exit(0);
}
run();
