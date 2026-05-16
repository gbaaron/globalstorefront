const Airtable = require('airtable');
const jwt = require('jsonwebtoken');

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Verify admin JWT
  const authHeader = event.headers.authorization || event.headers.Authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET);
  } catch (err) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid token' }) };
  }

  try {
    const { tenantId, baseId, siteType } = JSON.parse(event.body);

    if (!tenantId || !baseId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'tenantId and baseId required' }) };
    }

    const apiKey = process.env.AIRTABLE_API_KEY;
    const clientBase = new Airtable({ apiKey }).base(baseId);
    const gsBase = new Airtable({ apiKey }).base(process.env.AIRTABLE_BASE_ID);

    // Determine which table to pull from based on siteType
    let sourceTable = '';
    let category = 'general';
    let mapFn = null;

    if (siteType === 'product' || siteType === 'retail') {
      sourceTable = 'Products';
      category = 'menu';
      mapFn = (record) => ({
        key: (record.fields.ProductName || record.fields.Name || '').toLowerCase().replace(/\s+/g, '_'),
        value: formatProductEntry(record.fields)
      });
    } else if (siteType === 'restaurant') {
      // Try MenuItems first, fallback to Menu Items
      sourceTable = 'MenuItems';
      category = 'menu';
      mapFn = (record) => ({
        key: (record.fields.Name || '').toLowerCase().replace(/\s+/g, '_'),
        value: formatMenuEntry(record.fields)
      });
    } else if (siteType === 'service') {
      sourceTable = 'Services';
      category = 'services';
      mapFn = (record) => ({
        key: (record.fields.Name || record.fields.ServiceName || '').toLowerCase().replace(/\s+/g, '_'),
        value: formatServiceEntry(record.fields)
      });
    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Unknown siteType: ${siteType}. Use product, restaurant, or service.` }) };
    }

    // Fetch records from client's base
    let sourceRecords = [];
    try {
      sourceRecords = await fetchAll(clientBase, sourceTable);
    } catch (err) {
      // Try alternate table names
      if (siteType === 'restaurant') {
        try {
          sourceRecords = await fetchAll(clientBase, 'Menu Items');
        } catch (e2) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: `Could not find table: ${sourceTable} or Menu Items in base ${baseId}` }) };
        }
      } else {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Could not find table: ${sourceTable} in base ${baseId}` }) };
      }
    }

    // Fetch existing KB entries for this tenant
    const existingEntries = await fetchAll(gsBase, 'BotKnowledgeBase', {
      filterByFormula: `{TenantID} = '${tenantId}'`
    });
    const existingKeys = new Set(existingEntries.map(e => e.fields.Key));

    // Map source records to KB entries
    const newEntries = [];
    let skipped = 0;

    for (const record of sourceRecords) {
      const mapped = mapFn(record);
      if (!mapped.key || !mapped.value) continue;

      if (existingKeys.has(mapped.key)) {
        skipped++;
        continue;
      }

      newEntries.push({
        fields: {
          TenantID: tenantId,
          Category: category,
          Key: mapped.key,
          Value: mapped.value,
          Priority: 5
        }
      });
    }

    // Batch write to BotKnowledgeBase (10 at a time)
    let imported = 0;
    for (let i = 0; i < newEntries.length; i += 10) {
      const batch = newEntries.slice(i, i + 10);
      await gsBase('BotKnowledgeBase').create(batch);
      imported += batch.length;
      if (i + 10 < newEntries.length) {
        await new Promise(r => setTimeout(r, 250));
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, imported, skipped, total: sourceRecords.length })
    };
  } catch (error) {
    console.error('Bulk import error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Import failed: ' + error.message }) };
  }
};

// Helper: fetch all records from a table with pagination
async function fetchAll(base, tableName, options = {}) {
  const records = [];
  await base(tableName).select(options).eachPage((page, next) => {
    records.push(...page);
    next();
  });
  return records;
}

// Format a product record into a KB value string
function formatProductEntry(f) {
  const parts = [];
  if (f.ProductName || f.Name) parts.push(`Product: ${f.ProductName || f.Name}`);
  if (f.Category) parts.push(`Category: ${f.Category}`);
  if (f.Price) parts.push(`Price: $${parseFloat(f.Price).toFixed(2)}`);
  if (f.Description) parts.push(`Description: ${f.Description}`);
  if (f.IsActive === false) parts.push('(Currently unavailable)');
  return parts.join('\n');
}

// Format a menu item into a KB value string
function formatMenuEntry(f) {
  const parts = [];
  if (f.Name) parts.push(`Item: ${f.Name}`);
  if (f.Category) parts.push(`Category: ${f.Category}`);
  if (f.Price) parts.push(`Price: $${parseFloat(f.Price).toFixed(2)}`);
  if (f.Description) parts.push(`Description: ${f.Description}`);
  if (f.IsAvailable === false) parts.push('(Currently unavailable)');
  if (f.AvgRating) parts.push(`Rating: ${f.AvgRating}/5`);
  return parts.join('\n');
}

// Format a service record into a KB value string
function formatServiceEntry(f) {
  const parts = [];
  if (f.Name || f.ServiceName) parts.push(`Service: ${f.Name || f.ServiceName}`);
  if (f.Category) parts.push(`Category: ${f.Category}`);
  if (f.Price) parts.push(`Price: $${parseFloat(f.Price).toFixed(2)}`);
  if (f.Duration) parts.push(`Duration: ${f.Duration} minutes`);
  if (f.Description) parts.push(`Description: ${f.Description}`);
  if (f.IsActive === false) parts.push('(Currently unavailable)');
  return parts.join('\n');
}
