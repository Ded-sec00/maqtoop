# CI لاختبارات PostgreSQL وHTTP

يرتبط بالمهمة08 في EXECUTION_PLAN.md وبمتطلب العزل R03 والتحقق الحقيقي في RULES.md. الملف [.github/workflows/tests.yml](../../.github/workflows/tests.yml) يشغّل فحصًا اسمه الثابت **PostgreSQL + HTTP** على Windows وNode22 عند كل push وpull_request وmerge_group، دون مرشحات مسارات أو تجاوز طلبات المسودة. صلاحية الرمز contents:read فقط، ولا يحتاج أسرارًا أو قاعدة خارجية أو مزود دفع.

يثبت الاعتماديات بأمر npm ci لكل من backend وdb/first_purchase، باستخدام ملفات القفل الحالية. إجراءات GitHub الرسمية مثبتة بمعرفات commit، والمهلة20 دقيقة. لا ينفذ CI نشرًا.

## شروط النجاح

1. تنجح اختبارات الحارس بأمر `node --test scripts/ci/run-tests.test.mjs`.
2. يشغّل `node scripts/ci/run-tests.mjs` المجموعة الحقيقية. يحذف التقرير التاريخي أولًا، ويرفض فشل العملية أو انتهاء المهلة أو تعذر تشغيلها حتى إذا ادعى تقريرها النجاح.
3. يكون report.passed=true بلا error، ويطابق عدد النتائج expectedCount مع حد أدنى77، وتنجح كل حالة مع اسم فريد ودليل غير فارغ.

صفر اختبارات، وفشل حالة واحدة، والتقرير المفقود أو غير الصحيح، والنتائج الناقصة كلها تفشل التشغيل. الحد الأدنى77 هو حجم المجموعة عند إضافة CI؛ أي خفض متعمد له يحتاج تعديلًا ومراجعة. الملفات المصطنعة في اختبارات الحارس تثبت سلوك القبول والرفض فقط؛ دليل PostgreSQL الحقيقي يأتي من المجموعة الكاملة.

يمكن تشغيل الأمرين نفسيهما محليًا بعد تثبيت الاعتماديات. تعديل التقرير التاريخي results.json نتيجة متوقعة عند تشغيل المجموعة؛ لا يعتمد CI نسخته المحفوظة في Git.

## قراءة النتائج

افتح Actions ثم PostgreSQL and HTTP tests. يعرض الفحص عدد الحالات في Summary، ويحفظ results.json في artifact اسمه test-results متبوعًا بمعرف التشغيل والمحاولة لمدة14 يومًا. يُحاول رفع التقرير حتى عند فشل الاختبارات، وقد لا يوجد تقرير إن فشل تثبيت الاعتماديات أو بدء المحرك؛ سجلات الخطوة هي الدليل في تلك الحالة.

## تفعيل منع الدمج — ينفذه مسؤول المستودع

بعد مراجعة ودمج CI في الفرع المستهدف وظهور الفحص في تشغيل ناجح:

1. افتح المستودع ثم Settings → Rules → Rulesets → New ruleset → New branch ruleset.
2. سمّ القاعدة وفعّل Enforcement status = Active، وحدد Target branches = main. أضف فروع التكامل المستخدمة إذا أردت حمايتها أيضًا، بعد وصول workflow إليها.
3. فعّل Require a pull request before merging واجعل عدد الموافقات المطلوبة1 على الأقل، مع Dismiss stale pull request approvals when new commits are pushed.
4. فعّل Require status checks to pass، ثم Add checks واختر **PostgreSQL + HTTP** من GitHub Actions. فعّل Require branches to be up to date before merging.
5. لا تضف bypass للمستخدمين اليوميين، واحفظ القاعدة. راجع إعدادات الجهات المستثناة إن كانت هناك قاعدة تنظيمية قائمة.

الاختبار الأحمر يمنع الدمج فقط بعد تفعيل القاعدة؛ وجود workflow وحده لا يفرض المنع. الطلبات القديمة التي لا تحتوي workflow تحتاج تحديث فروعها لتشغيل الفحص، وإلا تبقى النتيجة المطلوبة منتظرة. لا يُدمج الطلب من المؤلف وحده وفق RULES.md. لم يغيّر هذا العمل حماية الفروع.

المراجع الرسمية: [إنشاء ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)، [الفحوص المطلوبة](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)، [تشخيص الفحوص المطلوبة](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks).
