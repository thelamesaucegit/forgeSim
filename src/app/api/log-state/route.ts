// src/app/api/log-state/route.ts

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

// Ensure these environment variables are set in your deployment environment (e.g., DigitalOcean App Platform)
// and in a .env.local file for local development.


// This is a server-side only Supabase client. It uses the powerful service_role key
// which should never be exposed to the browser.
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);


// Define the shape of the data we expect to receive from the Java logger
// This provides type safety and prevents 'any' types.
interface LogStateRequestBody {
  matchId: string;
  state: object; // The SpectatorStateUpdate from Java will be deserialized into a generic object
}

// This function is the core of the API route. It handles incoming POST requests.
export async function POST(request: Request) {
  try {
    // 1. Parse the incoming request body as JSON.
    const body = (await request.json()) as LogStateRequestBody;
    const { matchId, state } = body;

    // 2. Validate the payload.
    if (!matchId || !state) {
      return NextResponse.json({ error: 'Missing matchId or state payload' }, { status: 400 });
    }

    // 3. Call the PostgreSQL function we created earlier to append the new state.
    //    Using an RPC (Remote Procedure Call) is the recommended way to interact with db functions.
    //    The function name `append_to_match_logs` and its parameters must match what we defined in the SQL editor.
    const { error } = await supabase.rpc('append_to_match_logs', {
        match_id_to_append: matchId,
        new_state_to_append: state
    });

    // 4. Handle any potential database errors.
    if (error) {
      console.error('Supabase RPC error while appending log:', error);
      return NextResponse.json({ error: 'Failed to write log to database', details: error.message }, { status: 500 });
    }

    // 5. If successful, return a success message.
    return NextResponse.json({ message: 'Log received and processed successfully' });

  } catch (err: unknown) {
    const error = err as Error;
    console.error('API Error in /api/log-state:', error);
    return NextResponse.json({ error: 'Invalid request body. Ensure it is valid JSON.', details: error.message }, { status: 400 });
  }
}
