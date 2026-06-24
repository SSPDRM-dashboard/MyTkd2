const { initializeApp } = require("firebase/app");
const { getFirestore, doc, getDoc } = require("firebase/firestore");

const firebaseConfig = {
  "projectId": "vocal-vigil-452005-p0",
  "appId": "1:1065752980887:web:c93d813164daad4dbee8d2",
  "apiKey": "AIzaSyCU6GjKhUwN4Klxl64sZHHkqg23syNXTtc",
  "authDomain": "vocal-vigil-452005-p0.firebaseapp.com"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app, "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849");

async function check() {
  const snap = await getDoc(doc(db, "sync", "tkd_categories"));
  if (snap.exists()) {
    console.log(JSON.stringify(snap.data(), null, 2));
  } else {
    console.log("Not found categories");
  }
}
check();
