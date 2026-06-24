import { initializeApp } from 'firebase/app';
import { getFirestore, getDoc, doc } from 'firebase/firestore';
import fs from 'fs';
import Papa from 'papaparse';

function normalize(str: string) {
  return str.replace(/[^0-9]/g, '');
}

const CSV_URL = 'https://docs.google.com/spreadsheets/d/14TrlxR_rk9S7WmdanXGLlE4Y-ry9TqY6_B6HYA0Uuus/export?format=csv';

async function run() {
  const response = await fetch(CSV_URL);
  const text = await response.text();
  const result = Papa.parse(text, { skipEmptyLines: true });
  const rows = result.data as string[][];

  let totalEvent2 = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[1]?.trim() === '2') {
      totalEvent2++;
    }
  }
  console.log("Total rows for Event 2 in CSV:", totalEvent2);
  process.exit(0);
}
run();
