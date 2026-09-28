import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { ExtractedProduct, Product } from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private auth = inject(AuthService);
  private client() { return this.auth.supabase(); }

  async listProducts(archived = false) {
    const { data, error } = await this.client().from('products').select('id,name,brand,expiration_date,confidence,status,created_at').eq('status', archived ? 'archived' : 'active').order('expiration_date', { ascending: true });
    if (error) throw error;
    return (data ?? []) as Product[];
  }

  async analyzePhoto(file: File, productId?: string) {
    const form = new FormData();
    form.append('image', file);
    if (productId) form.append('product_id', productId);
    const { data, error } = await this.client().functions.invoke<ExtractedProduct>('analyze-product', { body: form });
    if (error || !data) throw error || new Error('La función de análisis no devolvió datos.');
    return data;
  }

  async saveProduct(product: ExtractedProduct) {
    const ownerId = this.auth.session()?.user.id;
    if (!ownerId || !product.source_image_path) throw new Error('Sesión o imagen no válida.');
    const { data, error } = await this.client().from('products').insert({ owner_id: ownerId, name: product.name, brand: product.brand || null, expiration_date: product.expiration_date, date_label: product.date_label || null, confidence: product.confidence, source_image_path: product.source_image_path, status: 'active' }).select('id,name,brand,expiration_date,confidence,status,created_at').single();
    if (error) throw error;
    return data as Product;
  }

  async consume(id: string) {
    const { data, error } = await this.client().from('products').update({ status: 'archived', consumed_at: new Date().toISOString() }).eq('id', id).eq('status', 'active').select('id').single();
    if (error || !data) throw error || new Error('Producto no encontrado.');
    return data;
  }

  async subscribe(subscription: PushSubscriptionJSON) {
    const ownerId = this.auth.session()?.user.id;
    const keys = subscription.keys;
    if (!ownerId || !subscription.endpoint || !keys?.['p256dh'] || !keys['auth']) throw new Error('Suscripción de avisos no válida.');
    const { error } = await this.client().from('web_push_subscriptions').upsert({ owner_id: ownerId, endpoint: subscription.endpoint, p256dh: keys['p256dh'], auth: keys['auth'] }, { onConflict: 'owner_id,endpoint' });
    if (error) throw error;
  }
}
