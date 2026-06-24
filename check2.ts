import { initializeApp } from 'firebase/app';
import { getFirestore, getDocs, collection } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const snap = await getDocs(collection(db, 'matchHistory'));
  console.log("Total in matchHistory:", snap.size);
  const sample = snap.docs.find(d => d.data().eventId === '6a3gvhnei');
  if (sample) console.log("Sample 6a3gvhnei:", sample.id, sample.data());
  const groups = snap.docs.reduce((acc: any, doc: any) => {
     const eid = doc.data().eventId || 'none';
     acc[eid] = (acc[eid] || 0) + 1;
     return acc;
  }, {});
  console.log("MatchHistory counts:", groups);
  process.exit(0);
}
run();
