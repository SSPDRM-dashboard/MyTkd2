import { initializeApp } from 'firebase/app';
import { getFirestore, getDocs, collection, deleteDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const snap = await getDocs(collection(db, 'matchHistory'));
  let deletedCount = 0;
  for (const d of snap.docs) {
    const data = d.data();
    let dDate;
    if (data.syncedAt && data.syncedAt.toDate) {
      dDate = data.syncedAt.toDate();
    } else if (data.timestamp && data.timestamp.toDate) {
      dDate = data.timestamp.toDate();
    }
    
    // Delete matches older than 2026-06-06T15:00:00Z (which is roughly just before 2026-06-07 started in Malaysia/local time)
    if (!dDate || dDate.getTime() <= new Date('2026-06-06T15:00:00Z').getTime()) {
      await deleteDoc(doc(db, 'matchHistory', d.id));
      deletedCount++;
    }
  }
  console.log(`Deleted old matches: ${deletedCount}`);
  process.exit(0);
}
run();
