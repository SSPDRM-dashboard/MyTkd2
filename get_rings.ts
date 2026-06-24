import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const dRef = doc(db, 'sync', 'tkd_rings');
  const dSnap = await getDoc(dRef);
  if (dSnap.exists()) {
    console.log(JSON.stringify(dSnap.data().value, null, 2));
  } else {
    console.log("No tkd_rings exists in sync collection.");
  }
  process.exit(0);
}
run();
