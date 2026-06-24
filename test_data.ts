import { initializeApp } from 'firebase/app';
import { getFirestore, onSnapshot, doc, collection, query, getDoc, setDoc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

const unsubH = onSnapshot(collection(db, 'matchHistory'), async (snap) => {
  console.log("matchHistory size:", snap.size);
  if (snap.size > 0) {
    const byEvent = snap.docs.reduce((acc, doc) => {
       const eid = doc.data().eventId || 'none';
       acc[eid] = (acc[eid] || 0) + 1;
       return acc;
    }, {});
    console.log(byEvent);
    
    // update all to o6nsg2u9k
    for (const d of snap.docs) {
      await setDoc(doc(db, 'matchHistory', d.id), { eventId: 'o6nsg2u9k' }, { merge: true });
    }
    console.log("Updated matchHistory to o6nsg2u9k");
  }
  process.exit(0);
});
