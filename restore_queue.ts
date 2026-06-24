import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, setDoc, doc, collection, getDocs } from 'firebase/firestore';
import fs from 'fs';
import Papa from 'papaparse';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

const CSV_URL = 'https://docs.google.com/spreadsheets/d/14TrlxR_rk9S7WmdanXGLlE4Y-ry9TqY6_B6HYA0Uuus/export?format=csv';

function normalize(str: string) {
  return str.replace(/[^0-9]/g, '');
}

async function run() {
  // 1. Get old queue from either local variable or backup? 
  // Wait, I overwrote tkd_bout_queue to just 90 items in import_all.ts!
  // I need to fetch the backup or use what's already there if they synced.
  const qDoc = await getDoc(doc(db, 'sync', 'tkd_bout_queue'));
  let existingQueue = qDoc.exists() ? qDoc.data().value : [];
  
  // Actually, I want to merge it.
  console.log("Current queue count:", existingQueue.length);
  console.log("Items left:", existingQueue.map((i: any) => i.data.eventId + " " + i.data.ring + " " + i.data.bout + " " + i.data.blue_name));
  
  process.exit(0);
}
run();
