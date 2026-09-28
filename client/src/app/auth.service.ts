import { Injectable, signal } from '@angular/core';
import { createClient, Session, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../environments/environment';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private client: SupabaseClient | null = null;
  private initialization: Promise<void> | null = null;
  readonly session = signal<Session | null>(null);
  readonly vapidPublicKey = signal('');
  readonly ready = signal(false);

  async initialize() {
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeClient();
    return this.initialization;
  }

  private async initializeClient() {
    this.vapidPublicKey.set(environment.vapidPublicKey || '');
    if (!environment.supabaseUrl || !environment.supabasePublishableKey) { this.ready.set(true); return; }
    this.client = createClient(environment.supabaseUrl, environment.supabasePublishableKey, { auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: false } });
    this.client.auth.onAuthStateChange((_event, session) => this.session.set(session));
    const { data: { session } } = await this.client.auth.getSession();
    if (session) {
      const { error } = await this.client.auth.getUser();
      if (error) await this.client.auth.signOut({ scope: 'local' });
      else this.session.set(session);
    }
    this.ready.set(true);
  }

  configured() { return Boolean(this.client); }
  supabase() { if (!this.client) throw new Error('Supabase no está configurado.'); return this.client; }
  email() { return this.session()?.user.email || ''; }
  async signInWithPassword(email: string, password: string) {
    if (!this.client) throw new Error('Supabase no está configurado.');
    const { error } = await this.client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw error;
  }
  async signOut() {
    if (!this.client) return;
    const { error } = await this.client.auth.signOut({ scope: 'local' });
    if (error) throw error;
    this.session.set(null);
  }
}
