import { CommonModule, DatePipe } from '@angular/common';
import { Component, computed, effect, HostListener, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { AnalyzedProduct, Product, ProductInput } from './models';

type AnalysisJob = { id: string; fileName: string; state: 'processing' | 'error'; error?: string };

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule, DatePipe],
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  constructor() {
    void this.auth.initialize();
  }
  readonly products = signal<Product[]>([]);
  readonly pendingProducts = signal<Product[]>([]);
  readonly analysisJobs = signal<AnalysisJob[]>([]);
  readonly view = signal<'active' | 'archived'>('active');
  readonly replacingId = signal<string | null>(null);
  readonly captureDialogOpen = signal(false);
  readonly processing = computed(() =>
    this.analysisJobs().some((job) => job.state === 'processing'),
  );
  readonly manualDialogOpen = signal(false);
  readonly manualSaving = signal(false);
  readonly manualName = signal('');
  readonly manualBrand = signal('');
  readonly manualUnits = signal(1);
  readonly manualExpirationDate = signal('');
  readonly manualError = signal('');
  readonly editingProduct = signal<Product | null>(null);
  readonly editDialogOpen = signal(false);
  readonly editSaving = signal(false);
  readonly editName = signal('');
  readonly editBrand = signal('');
  readonly editUnits = signal(1);
  readonly editExpirationDate = signal('');
  readonly editError = signal('');
  readonly deleteDialogProduct = signal<Product | null>(null);
  readonly deleteLoading = signal(false);
  readonly consumeDialogProduct = signal<Product | null>(null);
  readonly consumeLoading = signal(false);
  readonly message = signal('Inicia sesión y añade una foto para crear tu inventario.');
  readonly loginEmail = signal('');
  readonly loginPassword = signal('');
  readonly passwordVisible = signal(false);
  readonly loginLoading = signal(false);
  readonly loginError = signal('');
  readonly logoutDialogOpen = signal(false);
  readonly logoutLoading = signal(false);
  readonly connected = signal(false);
  readonly daysToday = computed(
    () => this.products().filter((p) => this.daysUntil(p.expiration_date) === 0).length,
  );
  readonly daysSoon = computed(
    () =>
      this.products().filter((p) => {
        const d = this.daysUntil(p.expiration_date);
        return d > 0 && d <= 5;
      }).length,
  );
  readonly total = computed(() => this.products().length);
  readonly userEmail = computed(() => this.auth.email());
  private syncAuth = effect(() => {
    const session = this.auth.session();
    if (session && !this.connected()) {
      this.connected.set(true);
      this.loginError.set('');
      this.message.set('Tu despensa está sincronizada.');
      this.loadProducts();
    } else if (!session && this.connected()) {
      this.connected.set(false);
      this.products.set([]);
      this.pendingProducts.set([]);
      this.analysisJobs.set([]);
      this.view.set('active');
      this.message.set('Sesión cerrada. Tus productos permanecen protegidos.');
    }
  });
  async loadProducts() {
    if (!this.connected()) return;
    try {
      const [products, pendingProducts] = await Promise.all([
        this.api.listProducts(this.view() === 'archived' ? 'archived' : 'active'),
        this.api.listProducts('pending'),
      ]);
      this.products.set(products);
      this.pendingProducts.set(pendingProducts);
    } catch {
      this.message.set('No se han podido cargar los productos. Comprueba tu conexión y sesión.');
    }
  }
  onFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.message.set('Selecciona una imagen JPG, PNG o WebP.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      this.message.set('La imagen no puede superar 5 MB.');
      return;
    }
    const input = event.target as HTMLInputElement;
    input.value = '';
    const replacementId = this.replacingId();
    this.captureDialogOpen.set(false);
    this.replacingId.set(null);
    if (replacementId) {
      this.message.set('Actualizando el producto con la nueva foto.');
      void this.analyze(file, replacementId);
      return;
    }
    const jobId = crypto.randomUUID();
    this.analysisJobs.update((jobs) => [
      ...jobs,
      { id: jobId, fileName: file.name, state: 'processing' },
    ]);
    this.message.set('Foto añadida a la cola de análisis. Puedes seguir subiendo más.');
    void this.analyze(file, undefined, jobId);
  }
  async analyze(file: File, replacementId?: string, jobId?: string) {
    if (!this.connected()) {
      this.message.set('Inicia sesión antes de analizar y guardar una foto.');
      return;
    }
    try {
      const result = await this.api.analyzePhoto(file, replacementId);
      if (replacementId) {
        await this.loadProducts();
        this.message.set(
          result.needs_review
            ? `Foto procesada. Revisa ${this.analysisMissingText(result.missing_fields)} antes de darlo por actualizado.`
            : 'Producto actualizado con la nueva foto.',
        );
      } else if (jobId) {
        this.analysisJobs.update((jobs) => jobs.filter((job) => job.id !== jobId));
        this.pendingProducts.update((products) => [this.pendingProduct(result), ...products]);
        this.message.set(
          result.needs_review
            ? `${result.name || 'El producto'} necesita revisión antes de confirmarlo.`
            : `${result.name} está pendiente de tu confirmación.`,
        );
      }
    } catch {
      if (jobId) {
        this.analysisJobs.update((jobs) =>
          jobs.map((job) =>
            job.id === jobId
              ? { ...job, state: 'error', error: 'No se ha podido leer la foto.' }
              : job,
          ),
        );
      }
      this.message.set(
        'No se ha podido leer una de las fotos. Comprueba que la fecha se vea con nitidez.',
      );
    }
  }
  openConsumeDialog(product: Product, event?: Event) {
    const input = event?.target;
    if (input instanceof HTMLInputElement) input.checked = false;
    this.consumeDialogProduct.set(product);
    window.setTimeout(() => document.getElementById('consume-cancel')?.focus());
  }
  closeConsumeDialog() {
    if (this.consumeLoading()) return;
    const product = this.consumeDialogProduct();
    this.consumeDialogProduct.set(null);
    if (product)
      window.setTimeout(() => document.getElementById(`consume-product-${product.id}`)?.focus());
  }
  async confirmConsume() {
    const product = this.consumeDialogProduct();
    if (!product || !this.connected()) return;
    this.consumeLoading.set(true);
    try {
      await this.api.consume(product.id);
      this.products.update((items) => items.filter((item) => item.id !== product.id));
      this.consumeDialogProduct.set(null);
      this.message.set(`${product.name} se ha archivado como gastado.`);
    } catch {
      this.message.set('No se ha podido archivar el producto.');
    } finally {
      this.consumeLoading.set(false);
    }
  }
  async confirmPending(product: Product) {
    if (this.pendingNeedsReview(product)) {
      this.message.set(`Completa ${this.pendingMissingText(product)} antes de confirmarlo.`);
      this.openEditDialog(product);
      return;
    }
    try {
      const confirmed = await this.api.confirmProduct(product.id);
      this.pendingProducts.update((items) => items.filter((item) => item.id !== confirmed.id));
      if (this.view() === 'active') this.products.update((items) => [confirmed, ...items]);
      this.message.set(`${confirmed.name} ya está en tus productos activos.`);
    } catch {
      this.message.set('No se ha podido confirmar el producto. Inténtalo de nuevo.');
    }
  }
  openCaptureDialog() {
    this.replacingId.set(null);
    this.captureDialogOpen.set(true);
    window.setTimeout(() => document.getElementById('capture-close')?.focus());
  }
  closeCaptureDialog() {
    this.replacingId.set(null);
    this.captureDialogOpen.set(false);
    window.setTimeout(() => document.getElementById('capture-trigger')?.focus());
  }
  replace(product: Product) {
    this.replacingId.set(product.id);
    this.captureDialogOpen.set(true);
    window.setTimeout(() => document.getElementById('capture-close')?.focus());
    this.message.set(`Sube una nueva foto para actualizar la fecha de ${product.name}.`);
  }
  openManualDialog() {
    this.manualName.set('');
    this.manualBrand.set('');
    this.manualUnits.set(1);
    this.manualExpirationDate.set('');
    this.manualError.set('');
    this.manualDialogOpen.set(true);
    window.setTimeout(() => document.getElementById('manual-name')?.focus());
  }
  closeManualDialog() {
    if (this.manualSaving()) return;
    this.manualDialogOpen.set(false);
    window.setTimeout(() => document.getElementById('manual-trigger')?.focus());
  }
  async saveManualProduct() {
    const input = this.productInput(
      this.manualName(),
      this.manualBrand(),
      this.manualUnits(),
      this.manualExpirationDate(),
    );
    if (typeof input === 'string') {
      this.manualError.set(input);
      return;
    }
    this.manualSaving.set(true);
    this.manualError.set('');
    try {
      const saved = await this.api.saveManualProduct(input);
      if (this.view() === 'active') this.products.update((items) => [saved, ...items]);
      this.manualDialogOpen.set(false);
      this.message.set(`${saved.name} se ha añadido manualmente.`);
    } catch {
      this.manualError.set('No se ha podido guardar el producto. Inténtalo de nuevo.');
    } finally {
      this.manualSaving.set(false);
    }
  }
  openEditDialog(product: Product) {
    this.editingProduct.set(product);
    this.editName.set(product.name);
    this.editBrand.set(product.brand || '');
    this.editUnits.set(product.units ?? 1);
    this.editExpirationDate.set(product.expiration_date || '');
    this.editError.set('');
    this.editDialogOpen.set(true);
    window.setTimeout(() => document.getElementById('edit-name')?.focus());
  }
  closeEditDialog() {
    if (this.editSaving()) return;
    const product = this.editingProduct();
    this.editDialogOpen.set(false);
    this.editingProduct.set(null);
    if (product)
      window.setTimeout(() => document.getElementById(`edit-product-${product.id}`)?.focus());
  }
  async saveEdit() {
    const product = this.editingProduct();
    if (!product) return;
    const input = this.productInput(
      this.editName(),
      this.editBrand(),
      this.editUnits(),
      this.editExpirationDate(),
    );
    if (typeof input === 'string') {
      this.editError.set(input);
      return;
    }
    this.editSaving.set(true);
    this.editError.set('');
    try {
      const updated = await this.api.updateProduct(product.id, input);
      if (updated.status === 'pending')
        this.pendingProducts.update((items) =>
          items.map((item) => (item.id === updated.id ? updated : item)),
        );
      else
        this.products.update((items) =>
          items.map((item) => (item.id === updated.id ? updated : item)),
        );
      this.editDialogOpen.set(false);
      this.editingProduct.set(null);
      this.message.set(`${updated.name} se ha actualizado.`);
    } catch {
      this.editError.set('No se ha podido actualizar el producto. Inténtalo de nuevo.');
    } finally {
      this.editSaving.set(false);
    }
  }
  openDeleteDialog(product: Product) {
    this.deleteDialogProduct.set(product);
    window.setTimeout(() => document.getElementById('delete-cancel')?.focus());
  }
  closeDeleteDialog() {
    if (this.deleteLoading()) return;
    const product = this.deleteDialogProduct();
    this.deleteDialogProduct.set(null);
    if (product)
      window.setTimeout(() => document.getElementById(`delete-product-${product.id}`)?.focus());
  }
  async deleteProduct() {
    const product = this.deleteDialogProduct();
    if (!product) return;
    this.deleteLoading.set(true);
    try {
      await this.api.deleteProduct(product.id);
      this.products.update((items) => items.filter((item) => item.id !== product.id));
      this.pendingProducts.update((items) => items.filter((item) => item.id !== product.id));
      this.deleteDialogProduct.set(null);
      this.message.set(`${product.name} se ha eliminado definitivamente.`);
    } catch {
      this.message.set('No se ha podido eliminar el producto. Inténtalo de nuevo.');
    } finally {
      this.deleteLoading.set(false);
    }
  }
  setView(view: 'active' | 'archived') {
    this.view.set(view);
    this.loadProducts();
  }
  daysUntil(date: string | null) {
    if (!date) return Number.POSITIVE_INFINITY;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((new Date(`${date}T00:00:00`).getTime() - today.getTime()) / 86400000);
  }
  urgency(product: Product) {
    const days = this.daysUntil(product.expiration_date);
    if (days <= 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days <= 5) return 'soon';
    if (days <= 10) return 'watch';
    return 'safe';
  }
  urgencyText(product: Product) {
    const days = this.daysUntil(product.expiration_date);
    if (days < 0) return `Caducó hace ${Math.abs(days)} d`;
    if (days === 0) return 'Caduca hoy';
    if (days === 1) return 'Caduca mañana';
    return `Caduca en ${days} días`;
  }
  pendingNeedsReview(product: Product) {
    return product.needs_review || this.pendingMissingDetails(product).length > 0;
  }
  pendingMissingText(product: Product) {
    const fields = this.pendingMissingDetails(product);
    if (!fields.length) return 'los datos pendientes';
    return this.analysisMissingText(fields);
  }
  async enableNotifications() {
    if (!('Notification' in window)) {
      this.message.set('Este navegador no admite notificaciones.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      this.message.set('Necesitas aceptar los permisos para recibir avisos.');
      return;
    }
    if (!this.auth.vapidPublicKey() || !this.connected()) {
      this.message.set(
        'Avisos activados en el navegador. Añade la clave VAPID para recibir avisos aunque la app esté cerrada.',
      );
      return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: this.base64ToUint8Array(this.auth.vapidPublicKey()),
    });
    await this.api.subscribe(subscription.toJSON());
    this.message.set('Avisos activados. Te recordaremos los productos a 10, 5, 1 y 0 días.');
  }
  async signIn() {
    const email = this.loginEmail().trim();
    const password = this.loginPassword();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.loginError.set('Introduce un correo electrónico válido.');
      return;
    }
    if (!password) {
      this.loginError.set('Introduce tu contraseña.');
      return;
    }
    this.loginLoading.set(true);
    this.loginError.set('');
    try {
      await this.auth.initialize();
      if (!this.auth.configured()) throw new Error('Supabase no está configurado.');
      await this.auth.signInWithPassword(email, password);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'email_not_confirmed')
        this.loginError.set(
          'Este correo aún no está confirmado. Confírmalo desde Supabase > Authentication > Users.',
        );
      else if (code === 'email_provider_disabled')
        this.loginError.set('El acceso por correo y contraseña está desactivado en Supabase.');
      else if (!this.auth.configured())
        this.loginError.set(
          'Falta la configuración pública de Supabase. Reinicia la web e inténtalo de nuevo.',
        );
      else this.loginError.set('Correo o contraseña incorrectos, o el acceso no está disponible.');
    } finally {
      this.loginPassword.set('');
      this.passwordVisible.set(false);
      this.loginLoading.set(false);
    }
  }
  openLogoutDialog() {
    this.logoutDialogOpen.set(true);
    window.setTimeout(() => document.getElementById('logout-cancel')?.focus());
  }
  closeLogoutDialog() {
    if (this.logoutLoading()) return;
    this.logoutDialogOpen.set(false);
    window.setTimeout(() => document.getElementById('logout-trigger')?.focus());
  }
  @HostListener('document:keydown.escape') onEscape() {
    if (this.manualDialogOpen()) this.closeManualDialog();
    else if (this.editDialogOpen()) this.closeEditDialog();
    else if (this.consumeDialogProduct()) this.closeConsumeDialog();
    else if (this.deleteDialogProduct()) this.closeDeleteDialog();
    else if (this.captureDialogOpen()) this.closeCaptureDialog();
    else this.closeLogoutDialog();
  }
  async logout() {
    this.logoutLoading.set(true);
    try {
      await this.auth.signOut();
      this.logoutDialogOpen.set(false);
    } catch {
      this.message.set('No se ha podido cerrar la sesión. Inténtalo de nuevo.');
    } finally {
      this.logoutLoading.set(false);
    }
  }
  private productInput(
    name: string,
    brand: string,
    units: number,
    expirationDate: string,
  ): ProductInput | string {
    const normalizedName = name.trim();
    const normalizedBrand = brand.trim();
    if (!normalizedName) return 'Escribe el nombre del producto.';
    if (normalizedName.length > 180) return 'El nombre no puede superar 180 caracteres.';
    if (normalizedBrand.length > 120) return 'La marca no puede superar 120 caracteres.';
    if (!Number.isInteger(units) || units < 1 || units > 9999)
      return 'Indica entre 1 y 9.999 unidades.';
    if (!this.isValidIsoDate(expirationDate)) return 'Selecciona una fecha de caducidad válida.';
    return {
      name: normalizedName,
      brand: normalizedBrand || null,
      units,
      expiration_date: expirationDate,
    };
  }
  private isValidIsoDate(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  private pendingProduct(product: AnalyzedProduct): Product {
    return {
      id: product.id,
      name: product.name || 'Producto por identificar',
      brand: product.brand || null,
      units: product.units,
      expiration_date: product.expiration_date,
      confidence: product.confidence,
      needs_review: product.needs_review,
      status: 'pending',
      created_at: product.created_at,
    };
  }
  private base64ToUint8Array(value: string) {
    const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  private pendingMissingDetails(product: Product) {
    const fields: string[] = [];
    if (!product.name.trim() || product.name === 'Producto por identificar')
      fields.push('el producto');
    if (!product.expiration_date) fields.push('la fecha de caducidad');
    if (!product.units) fields.push('las unidades');
    return fields;
  }
  private analysisMissingText(fields: string[]) {
    if (fields.length < 2) return fields[0] || 'los datos pendientes';
    if (fields.length === 2) return `${fields[0]} y ${fields[1]}`;
    return `${fields.slice(0, -1).join(', ')} y ${fields.at(-1)}`;
  }
}
