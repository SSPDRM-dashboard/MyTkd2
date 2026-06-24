import { initializeApp } from 'firebase/app';
import { getFirestore, getDocs, collection, setDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const snap = await getDocs(collection(db, 'matchHistory'));
  let countDate = 0;
  let countMissingEventId = 0;
  for (const d of snap.docs) {
    const data = d.data();
    const ts = data.syncedAt; 
    let dDate;
    if (ts && ts.toDate) {
      dDate = ts.toDate();
    } else if (data.completedAt) {
      dDate = new Date(data.completedAt);
    }
    
    // The current time is 2026-06-07. Event 2 started today.
    // Anything completed before June 6th should be o6nsg2u9k
    if (dDate && dDate.getTime() < new Date('2026-06-06').getTime()) {
      countDate++;
      await setDoc(doc(db, 'matchHistory', d.id), { eventId: 'o6nsg2u9k' }, { merge: true });
    } else if (!dDate) {
      countMissingEventId++;
      // If we don't know the date, they're old bouts anyway, they were originally undefined, 
      // let's give them the old event ID o6nsg2u9k so they don't pollute Event 2's namespace.
      await setDoc(doc(db, 'matchHistory', d.id), { eventId: 'o6nsg2u9k' }, { merge: true });
    }
  }
  console.log("Reverted " + countDate + " old matches to o6nsg2u9k");
  console.log("Unknown date matches: " + countMissingEventId);
  process.exit(0);
}
run();
