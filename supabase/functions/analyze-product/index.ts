import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const allowedTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

type ProductDraft = {
  name: string;
  brand: string | null;
  units: number;
  expiration_date: string;
  confidence: number;
  date_label: string | null;
};

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function base64(file: File) {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let output = "";
    for (let start = 0; start < bytes.length; start += 0x8000)
      output += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    return btoa(output);
  });
}

function outputText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  return output
    .flatMap((item: { content?: unknown }) =>
      Array.isArray(item.content) ? item.content : [],
    )
    .filter(
      (item: { type?: string; text?: unknown }) =>
        item.type === "output_text" && typeof item.text === "string",
    )
    .map((item: { text: string }) => item.text)
    .join("");
}

function validDraft(value: unknown): value is ProductDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.name === "string" &&
    draft.name.trim().length > 0 &&
    draft.name.length <= 180 &&
    (draft.brand === null ||
      (typeof draft.brand === "string" && draft.brand.length <= 120)) &&
    typeof draft.units === "number" &&
    Number.isInteger(draft.units) &&
    draft.units >= 1 &&
    draft.units <= 9999 &&
    typeof draft.expiration_date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(draft.expiration_date) &&
    typeof draft.confidence === "number" &&
    draft.confidence >= 0 &&
    draft.confidence <= 1 &&
    (draft.date_label === null ||
      (typeof draft.date_label === "string" && draft.date_label.length <= 120))
  );
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST")
    return response({ error: "Método no permitido." }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL") || "";
    const publishableKeys = JSON.parse(
      Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}",
    ) as Record<string, string>;
    const publishableKey =
      publishableKeys.default || Deno.env.get("SUPABASE_ANON_KEY") || "";
    const authHeader = request.headers.get("Authorization") || "";
    if (!url || !publishableKey || !authHeader.startsWith("Bearer "))
      return response({ error: "No autorizado." }, 401);

    const token = authHeader.slice(7);
    const auth = createClient(url, publishableKey);
    const {
      data: { user },
      error: userError,
    } = await auth.auth.getUser(token);
    if (userError || !user)
      return response({ error: "Sesión no válida." }, 401);

    const form = await request.formData();
    const image = form.get("image");
    const productId = form.get("product_id");
    if (
      !(image instanceof File) ||
      !allowedTypes.has(image.type) ||
      image.size === 0 ||
      image.size > 5 * 1024 * 1024
    )
      return response(
        { error: "Usa una imagen JPG, PNG o WebP de hasta 5 MB." },
        422,
      );
    if (
      productId !== null &&
      (typeof productId !== "string" || !/^[0-9a-f-]{36}$/i.test(productId))
    )
      return response({ error: "Producto no válido." }, 422);

    const openAiKey =
      Deno.env.get("OPENAI_KEY") || Deno.env.get("OPENAI_API_KEY");
    if (!openAiKey)
      return response(
        { error: "El análisis de imágenes no está configurado." },
        503,
      );
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        brand: { type: ["string", "null"] },
        units: {
          type: "integer",
          minimum: 1,
          maximum: 9999,
          description:
            "Número de unidades del mismo producto y con esta misma fecha de caducidad visible en la imagen. Devuelve 1 si no se puede determinar otra cantidad con claridad.",
        },
        expiration_date: {
          type: ["string", "null"],
          description: "Fecha ISO YYYY-MM-DD; null si no se lee con certeza.",
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        date_label: { type: ["string", "null"] },
      },
      required: [
        "name",
        "brand",
        "units",
        "expiration_date",
        "confidence",
        "date_label",
      ],
      additionalProperties: false,
    };
    const ai = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: Deno.env.get("OPENAI_VISION_MODEL") || "gpt-5-mini",
        store: false,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Identifica el alimento o producto, la fecha de caducidad y cuántas unidades del mismo producto comparten esa fecha. Devuelve la fecha como YYYY-MM-DD. Cuenta las unidades solo si son visibles o aparecen claramente indicadas en el envase; si no se puede saber con certeza, devuelve 1. Si la fecha no se ve con certeza, devuelve null; nunca inventes una fecha.",
              },
              {
                type: "input_image",
                image_url: `data:${image.type};base64,${await base64(image)}`,
                detail: "high",
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "expiry_product",
            strict: true,
            schema,
          },
        },
      }),
    });
    if (!ai.ok) {
      console.error("OpenAI response failed", ai.status);
      return response({ error: "No se ha podido analizar la imagen." }, 502);
    }
    const parsed = JSON.parse(outputText(await ai.json()));
    if (!validDraft(parsed))
      return response(
        { error: "No hemos podido leer la fecha con suficiente certeza." },
        422,
      );

    const client = createClient(url, publishableKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const extension =
      image.type === "image/png"
        ? "png"
        : image.type === "image/webp"
          ? "webp"
          : "jpg";
    const path = `${user.id}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await client.storage
      .from("product-images")
      .upload(path, image, { contentType: image.type, upsert: false });
    if (uploadError) {
      console.error("Storage upload failed", uploadError.message);
      return response({ error: "No se ha podido guardar la foto." }, 502);
    }

    let storedProduct: {
      id: string;
      status: string;
      created_at: string;
    } | null = null;
    if (typeof productId === "string") {
      const { data: original, error: originalError } = await client
        .from("products")
        .select("id,expiration_date,source_image_path")
        .eq("id", productId)
        .eq("status", "active")
        .single();
      if (originalError || !original)
        return response({ error: "Producto no encontrado." }, 404);
      const { error: versionError } = await client
        .from("product_versions")
        .insert({
          owner_id: user.id,
          product_id: original.id,
          previous_expiration_date: original.expiration_date,
          previous_image_path: original.source_image_path,
          replacement_image_path: path,
        });
      if (versionError)
        return response(
          { error: "No se ha podido guardar el historial." },
          502,
        );
      const { data, error: updateError } = await client
        .from("products")
        .update({
          name: parsed.name.trim(),
          brand: parsed.brand?.trim() || null,
          units: parsed.units,
          expiration_date: parsed.expiration_date,
          confidence: parsed.confidence,
          date_label: parsed.date_label?.trim() || null,
          source_image_path: path,
        })
        .eq("id", productId)
        .select("id,status,created_at")
        .single();
      if (updateError || !data)
        return response(
          { error: "No se ha podido actualizar el producto." },
          502,
        );
      storedProduct = data;
    } else {
      const { data, error: insertError } = await client
        .from("products")
        .insert({
          owner_id: user.id,
          name: parsed.name.trim(),
          brand: parsed.brand?.trim() || null,
          units: parsed.units,
          expiration_date: parsed.expiration_date,
          confidence: parsed.confidence,
          date_label: parsed.date_label?.trim() || null,
          source_image_path: path,
          status: "pending",
        })
        .select("id,status,created_at")
        .single();
      if (insertError || !data) {
        await client.storage.from("product-images").remove([path]);
        return response(
          { error: "No se ha podido guardar el producto pendiente." },
          502,
        );
      }
      storedProduct = data;
    }

    return response({
      ...parsed,
      name: parsed.name.trim(),
      brand: parsed.brand?.trim() || null,
      date_label: parsed.date_label?.trim() || null,
      source_image_path: path,
      id: storedProduct!.id,
      status: storedProduct!.status,
      created_at: storedProduct!.created_at,
    });
  } catch (error) {
    console.error(
      "analyze-product failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return response({ error: "No se ha podido procesar la imagen." }, 500);
  }
});
