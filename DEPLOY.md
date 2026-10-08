# نشر cigram-together-api (خدمة «شاهد مع صديقك»)

لم يُنشر شيء. هذه الخطوات لك (تحتاج حساب Cloudflare الذي يملك cigram-auth-api).

1. أنشئ مستودعاً (أو مجلداً) فيه `worker.js` و`wrangler.jsonc` من هذا المجلد.
   لإعادة استخدام نمط النشر السابق انسخ `.github/workflows/deploy.yml` من cigram-ads-api (يحتاج Secrets:
   CLOUDFLARE_API_TOKEN و CLOUDFLARE_ACCOUNT_ID).
2. تأكد أن اسم Worker الحسابات في Cloudflare هو `cigram-auth-api` (Workers & Pages). إن كان مختلفاً عدّل
   `services[0].service` في wrangler.jsonc، وإلا سيفشل النشر برسالة واضحة.
3. انشر: `npx wrangler deploy` (أول نشر ينفّذ migration v1 فينشئ الـ Durable Objects بـ SQLite).
4. اختبر بلا حساب: `curl https://cigram-together-api.<account>.workers.dev/health` ← `{"ok":true,...}`.
5. إن اختلف العنوان عن `https://cigram-together-api.wwq-mixtv.workers.dev` عدّل `CigramTogetherApi.BASE` في التطبيق.
   (BASE فارغ = الميزة مغلقة و«شاهد الآن» يفتح المشغل الفردي مباشرة.)
6. لا توجد أسرار في هذا الـ Worker. التحقق من المستخدم عبر `AUTH_API` ← `/me` فقط.

## اختبار الخادم محلياً (تم تشغيله هنا: 45 فحصاً ناجحاً)
    cd test && npm install && npm test
