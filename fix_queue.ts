import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, setDoc, doc } from 'firebase/firestore';
import fs from 'fs';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function run() {
  const eDoc = await getDoc(doc(db, 'sync', 'tkd_events_v3'));
  console.log("Events:", eDoc.exists() ? eDoc.data().value : "None");

  const qDoc = await getDoc(doc(db, 'sync', 'tkd_bout_queue'));
  if (qDoc.exists()) {
    let data = qDoc.data().value;
    
    // Check if any match o6nsg2u9k
    const matchCurrent = data.filter((i: any) => i.data?.eventId === 'o6nsg2u9k');
    console.log("Queue matching o6nsg2u9k:", matchCurrent.length);
    
    // Convert 'dqyof3jl4' to 'o6nsg2u9k' since it has 316 bouts (probably the missing ones for Day 2)
    let updatedData = data.map((item: any) => {
       return { ...item, data: { ...item.data, eventId: '6a3gvhnei' } };
    });
    
    await setDoc(doc(db, 'sync', 'tkd_bout_queue'), { value: updatedData });
    console.log("Updated queue to have o6nsg2u9k.");
  }
  process.exit(0);
}
run();
