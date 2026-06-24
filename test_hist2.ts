import { initializeApp } from 'firebase/app';
import { getFirestore, getDocs, collection } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const snap = await getDocs(collection(db, 'matchHistory'));
  snap.forEach(d => {
    const data = d.data();
    if (data.eventId === '6a3gvhnei') {
       if (data.ring == 3 || data.bout.startsWith('3')) {
          console.log(data);
       }
    }
  });
  process.exit(0);
}
run();
