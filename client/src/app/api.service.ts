import { Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { AnalyzedProduct, Product, ProductInput, ProductStatus } from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private auth = inject(AuthService);
  private client() {
    return this.auth.supabase();
  }

  async listProducts(status: ProductStatus = 'active') {
    const { data, error } = await this.client()
      .from('products')
      .select('id,name,brand,units,expiration_date,confidence,needs_review,status,created_at')
      .eq('status', status)
      .order('expiration_date', { ascending: true });
    if (error) throw error;
    return (data ?? []) as Product[];
  }

  async analyzePhoto(file: File, productId?: string) {
    const form = new FormData();
    form.append('image', file);
    if (productId) form.append('product_id', productId);
    const { data, error } = await this.client().functions.invoke<AnalyzedProduct>(
      'analyze-product',
      { body: form },
    );
    if (error || !data) throw error || new Error('La función de análisis no devolvió datos.');
    return data;
  }

  async confirmProduct(id: string) {
    const { data, error } = await this.client()
      .from('products')
      .update({ status: 'active' })
      .eq('id', id)
      .eq('status', 'pending')
      .eq('needs_review', false)
      .select('id,name,brand,units,expiration_date,confidence,needs_review,status,created_at')
      .single();
    if (error || !data) throw error || new Error('Producto no encontrado.');
    return data as Product;
  }

  async saveManualProduct(product: ProductInput) {
    const ownerId = this.auth.session()?.user.id;
    if (!ownerId) throw new Error('Sesión no válida.');
    const { data, error } = await this.client()
      .from('products')
      .insert({
        owner_id: ownerId,
        name: product.name,
        brand: product.brand || null,
        units: product.units,
        expiration_date: product.expiration_date,
        date_label: null,
        confidence: 1,
        needs_review: false,
        source_image_path: null,
        status: 'active',
      })
      .select('id,name,brand,units,expiration_date,confidence,needs_review,status,created_at')
      .single();
    if (error) throw error;
    return data as Product;
  }

  async updateProduct(id: string, product: ProductInput) {
    const { data, error } = await this.client()
      .from('products')
      .update({
        name: product.name,
        brand: product.brand || null,
        units: product.units,
        expiration_date: product.expiration_date,
        needs_review: false,
      })
      .eq('id', id)
      .select('id,name,brand,units,expiration_date,confidence,needs_review,status,created_at')
      .single();
    if (error || !data) throw error || new Error('Producto no encontrado.');
    return data as Product;
  }

  async deleteProduct(id: string) {
    const { data: product, error: productError } = await this.client()
      .from('products')
      .select('source_image_path')
      .eq('id', id)
      .single();
    if (productError || !product) throw productError || new Error('Producto no encontrado.');
    const { data: versions, error: versionsError } = await this.client()
      .from('product_versions')
      .select('previous_image_path,replacement_image_path')
      .eq('product_id', id);
    if (versionsError) throw versionsError;
    const { data, error } = await this.client()
      .from('products')
      .delete()
      .eq('id', id)
      .select('id')
      .single();
    if (error || !data) throw error || new Error('Producto no encontrado.');
    const imagePaths = [
      product.source_image_path,
      ...(versions ?? []).flatMap((version) => [
        version.previous_image_path,
        version.replacement_image_path,
      ]),
    ].filter((path): path is string => typeof path === 'string' && path.length > 0);
    if (imagePaths.length) {
      const { error: storageError } = await this.client()
        .storage.from('product-images')
        .remove([...new Set(imagePaths)]);
      if (storageError)
        console.error(
          'No se han podido limpiar las fotos del producto eliminado.',
          storageError.message,
        );
    }
    return data;
  }

  async consume(id: string) {
    const { data, error } = await this.client()
      .from('products')
      .update({ status: 'archived', consumed_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'active')
      .select('id')
      .single();
    if (error || !data) throw error || new Error('Producto no encontrado.');
    return data;
  }

  async subscribe(subscription: PushSubscriptionJSON) {
    const ownerId = this.auth.session()?.user.id;
    const keys = subscription.keys;
    if (!ownerId || !subscription.endpoint || !keys?.['p256dh'] || !keys['auth'])
      throw new Error('Suscripción de avisos no válida.');
    const { error } = await this.client().from('web_push_subscriptions').upsert(
      {
        owner_id: ownerId,
        endpoint: subscription.endpoint,
        p256dh: keys['p256dh'],
        auth: keys['auth'],
      },
      { onConflict: 'owner_id,endpoint' },
    );
    if (error) throw error;
  }
}
