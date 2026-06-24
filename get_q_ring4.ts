import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const dRef = doc(db, 'sync', 'tkd_bout_queue');
  const dSnap = await getDoc(dRef);
  if (dSnap.exists()) {
    const queue = dSnap.data().value || [];
    const ring4Items = queue.filter((item: any) => item.data?.ring === 4);
    console.log("Ring 4 Queue Items:", JSON.stringify(ring4Items, null, 2));
  } else {
    console.log("No tkd_bout_queue document.");
  }
  process.exit(0);
}
run();
