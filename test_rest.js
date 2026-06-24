const project = "vocal-vigil-452005-p0";
const db = "ai-studio-e1347685-6c03-4b4d-bc4e-0dc0bfd5b849";

async function run() {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/${db}/documents/sync/tkd_bout_queue`;
  
  const response = await fetch(url);
  const data = await response.json();
  
  if (data.fields && data.fields.value && data.fields.value.arrayValue) {
      const queue = data.fields.value.arrayValue.values || [];
      const cBouts = queue.filter(q => {
          const map = q.mapValue?.fields || {};
          const dataField = map.data?.mapValue?.fields || {};
          const ring = dataField.ring?.integerValue || '1';
          const bout = dataField.bout?.stringValue || dataField.bout?.integerValue || '';
          
          if (ring === '3' || String(bout).toUpperCase().startsWith('C') || String(bout).startsWith('30')) return true;
          return false;
      });
            
      cBouts.forEach(q => {
          const dataField = q.mapValue.fields.data.mapValue.fields;
          const bout = dataField.bout?.stringValue || dataField.bout?.integerValue || '';
          const blue = dataField.blue_name?.stringValue || '';
          const red = dataField.red_name?.stringValue || '';
          const eventId = dataField.eventId?.stringValue || '';
          
          const boutStr = String(bout).toUpperCase();
          if (['17', '18', '19', '20', '21', '22', '31'].some(num => boutStr.endsWith(num) || boutStr.includes('C' + num) || boutStr.includes('30' + num))) {
            console.log("In Queue:", boutStr, eventId, blue, "vs", red);
          }
      });
  } else {
      console.log("Failed to fetch or parse queue", data);
  }
}
run().catch(console.error);
