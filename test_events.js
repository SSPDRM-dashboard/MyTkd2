const project = "vocal-vigil-452005-p0";
const db = "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849";

async function run() {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/${db}/documents/sync/tkd_events_v3`;
  
  const response = await fetch(url);
  const data = await response.json();
  
  if (data.fields && data.fields.value && data.fields.value.arrayValue) {
      const events = data.fields.value.arrayValue.values || [];
      events.forEach(e => {
          const fields = e.mapValue.fields;
          console.log("Event:", fields.id.stringValue, fields.name.stringValue);
      });
  } else {
      console.log("Failed to fetch or parse", data);
  }
}
run().catch(console.error);
