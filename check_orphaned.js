const project = "vocal-vigil-452005-p0";
const db = "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849";

async function run() {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/${db}/documents/sync/tkd_bout_queue`;
  
  const response = await fetch(url);
  const data = await response.json();
  
  if (data.fields && data.fields.value && data.fields.value.arrayValue) {
      const queue = data.fields.value.arrayValue.values || [];
      const orphaned = queue.filter(q => {
          const dataField = q.mapValue.fields.data.mapValue.fields;
          return dataField.eventId?.stringValue === 'hyihmup5f';
      });
      console.log(`Found ${orphaned.length} orphaned bouts with eventId hyihmup5f`);
      const sample = orphaned.slice(0, 10).map(q => {
          const df = q.mapValue.fields.data.mapValue.fields;
          return `Ring: ${df.ring?.integerValue || df.ring?.stringValue}, Bout: ${df.bout?.stringValue || df.bout?.integerValue}`;
      });
      console.log(sample);
  } 
}
run().catch(console.error);
