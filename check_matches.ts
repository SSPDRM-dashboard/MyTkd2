import { initializeApp } from 'firebase/app';
import { getFirestore, getDocs, collection } from 'firebase/firestore';
import fs from 'fs';
import Papa from 'papaparse';

const app = initializeApp(JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8')));
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

const CSV_URL = 'https://docs.google.com/spreadsheets/d/14TrlxR_rk9S7WmdanXGLlE4Y-ry9TqY6_B6HYA0Uuus/export?format=csv';

function normalize(str: string) {
  return str.replace(/[^0-9]/g, '');
}

async function run() {
  const snap = await getDocs(collection(db, 'matchHistory'));
  let inHistory = new Set();
  snap.forEach(d => {
    const data = d.data();
    if (data.eventId === '6a3gvhnei' && data.bout) {
      inHistory.add(normalize(data.bout));
    }
  });
  console.log("Unique bouts in history today:", inHistory.size);

  const response = await fetch(CSV_URL);
  const text = await response.text();
  const result = Papa.parse(text, { skipEmptyLines: true });
  const rows = result.data as string[][];

  let matchesFromCsv = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[1]?.trim() === '2') {
       if (inHistory.has(normalize(row[3]))) {
         matchesFromCsv++;
       }
    }
  }
  console.log("Matches in history that are found in CSV:", matchesFromCsv);
  process.exit(0);
}
run();
