import { initializeApp } from 'firebase/app';
import { getFirestore, getDocs, collection } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const syncSnap = await getDocs(collection(db, 'sync'));
  syncSnap.forEach(d => {
    console.log(d.id, ":", JSON.stringify(d.data()).substring(0, 300));
  });
  process.exit(0);
}
run();
