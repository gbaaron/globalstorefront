const Airtable = require('airtable');
const { OpenAI } = require('openai');

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

    try {
        const { message, tenantId, sessionId, conversationHistory } = JSON.parse(event.body);

        if (!message || !tenantId) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'message and tenantId required' }) };
        }

        const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

        // Fetch tenant info from Clients table
        let tenant;
        try {
            tenant = await base('Clients').find(tenantId);
        } catch (e) {
            return { statusCode: 404, headers, body: JSON.stringify({ error: 'Tenant not found' }) };
        }

        const tenantName = tenant.get('Company') || tenant.get('Name') || 'this business';
        const botPersona = tenant.get('BotPersona') || 'Store Helper';
        const botVoice = tenant.get('BotVoice') || 'friendly, concise, and helpful';

        // Fetch knowledge base for this tenant
        const kbRecords = await base('BotKnowledgeBase').select({
            filterByFormula: `{TenantID} = '${tenantId}'`,
            sort: [{ field: 'Priority', direction: 'desc' }]
        }).firstPage();

        // Build knowledge context
        let knowledgeContext = '';
        if (kbRecords.length > 0) {
            const grouped = {};
            for (const rec of kbRecords) {
                const cat = rec.get('Category') || 'general';
                if (!grouped[cat]) grouped[cat] = [];
                grouped[cat].push(`${rec.get('Key')}: ${rec.get('Value')}`);
            }
            for (const [cat, entries] of Object.entries(grouped)) {
                knowledgeContext += `\n[${cat.toUpperCase()}]\n${entries.join('\n')}\n`;
            }
        }

        // Build system prompt
        const systemPrompt = `You are "${botPersona}", the AI assistant for ${tenantName}. Your tone is ${botVoice}.

KNOWLEDGE BASE:
${knowledgeContext || '(No specific knowledge loaded yet. Answer general questions helpfully but admit when you don\'t have specific details.)'}

RULES:
- Answer questions about ${tenantName} using ONLY the knowledge base above.
- If the answer is clearly in your knowledge base, respond directly and helpfully.
- If you're NOT SURE or the question requires specific info you don't have (custom orders, specific availability today, complaints, booking changes, etc.), respond with EXACTLY this format:
  [ESCALATE] I'll check with the team and get back to you on that.
- Keep responses under 3 sentences when possible.
- Never make up information about products, prices, hours, or policies.
- Never give medical, legal, or financial advice.
- If someone asks something completely unrelated to ${tenantName}, politely redirect: "I can help with questions about ${tenantName}! What would you like to know?"
- Do not use emojis unless the brand voice specifically calls for them.`;

        // Build messages array (last 6 turns max for context window)
        const messages = [{ role: 'system', content: systemPrompt }];
        if (conversationHistory && Array.isArray(conversationHistory)) {
            const recent = conversationHistory.slice(-6);
            for (const turn of recent) {
                messages.push({ role: turn.role, content: turn.content });
            }
        }
        messages.push({ role: 'user', content: message });

        // Call OpenAI
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages,
            temperature: 0.5,
            max_tokens: 500
        });

        const reply = completion.choices[0].message.content;
        const tokensIn = completion.usage?.prompt_tokens || 0;
        const tokensOut = completion.usage?.completion_tokens || 0;

        // Check if bot is escalating
        const shouldEscalate = reply.includes('[ESCALATE]');
        const cleanReply = reply.replace('[ESCALATE]', '').trim();

        // Log conversation (fire-and-forget)
        base('BotConversations').create([{
            fields: {
                SessionID: sessionId || `session_${Date.now()}`,
                TenantID: tenantId,
                UserMessage: message,
                AssistantMessage: cleanReply,
                Model: 'gpt-3.5-turbo',
                TokensIn: tokensIn,
                TokensOut: tokensOut,
                Escalated: shouldEscalate,
                Timestamp: new Date().toISOString()
            }
        }]).catch(() => {});

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                reply: cleanReply,
                escalate: shouldEscalate,
                sessionId: sessionId || `session_${Date.now()}`
            })
        };

    } catch (error) {
        console.error('Helper bot error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Something went wrong. Please try again.' })
        };
    }
};
