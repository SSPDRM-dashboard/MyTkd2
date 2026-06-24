import { initializeApp } from 'firebase/app';
import { getFirestore, getDocs, collection } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const snap = await getDocs(collection(db, 'matchHistory'));
  let todayCount = 0;
  let oldCount = 0;
  for (const d of snap.docs) {
    const data = d.data();
    let dDate;
    if (data.syncedAt && data.syncedAt.toDate) {
      dDate = data.syncedAt.toDate();
    } else if (data.timestamp && data.timestamp.toDate) {
      dDate = data.timestamp.toDate();
    }
    
    if (dDate && dDate.getTime() > new Date('2026-06-06T15:00:00Z').getTime()) { // Account for GMT+8 if needed
      todayCount++;
    } else {
      oldCount++;
    }
  }
  console.log(`Today matches: ${todayCount}, Old matches: ${oldCount}`);
  process.exit(0);
}
run();
