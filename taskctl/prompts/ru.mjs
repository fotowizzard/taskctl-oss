/**
 * Russian prompt pack — WP2 Stage 2b.
 *
 * Mirrors en.mjs structure with the SAME PROJECT-NEUTRAL semantics, translated
 * to Russian. This is the ONLY taskctl source file permitted to contain
 * Cyrillic (I3 allowance). It is NOT a copy of the original VP-laden prompts:
 * the origin-project assumptions (Supabase/RLS/Deno, named project, project-doc
 * references) are stripped here too. Project-specific guidance, if any, flows in
 * via config.projectContext / config.constraints (injected into context.md).
 *
 * Selecting `promptLanguage:'ru'` changes the language, never the project
 * assumptions.
 */

function reuseFirst() {
  return [
    '**ПРИНЦИП REUSE-FIRST:** Перед тем как предлагать новый код, тщательно изучи существующие',
    'компоненты, хуки, сервисы и утилиты в репозитории. Максимально используй то что уже есть.',
    'Новые файлы и функции — только если существующие НЕ покрывают задачу.',
  ];
}

export const pack = {
  // ── plan (cc-thingz flow) ────────────────────────────────────────────────
  planCc({ O, issueKey, noBrainstorm }) {
    const brainstormSection = noBrainstorm ? [
      '## РЕЖИМ: ПОЛНОСТЬЮ АВТОНОМНЫЙ',
      '',
      '**КРИТИЧНО: Ты работаешь в piped mode БЕЗ пользователя.**',
      '- НЕ используй skill brainstorm (НЕ вызывай /brainstorm:do)',
      '- НЕ задавай вопросов — некому отвечать',
      '- НЕ предлагай варианты на выбор — выбирай сам',
      '- Принимай все решения самостоятельно',
      '- ОБЯЗАТЕЛЬНО создай файл plan.md в конце',
      '',
      '## Шаг 1 — Анализ (без brainstorm skill)',
      '',
      `Прочитай контекст задачи: ${O}/ai/tasks/${issueKey}/context.md`,
      'Изучи затронутый код в репозитории. Определи лучший подход самостоятельно.',
      '',
      ...reuseFirst(),
      '',
      '## Шаг 2 — Создай plan.md',
      '',
      'Запусти /plan-make:do с описанием выбранного подхода.',
      '**Если /plan-make:do недоступен — создай plan.md вручную по шаблону.**',
      `Результат ОБЯЗАТЕЛЬНО сохрани в ${O}/ai/tasks/${issueKey}/plan.md.`,
      '',
      '**ПРОВЕРКА: файл plan.md ДОЛЖЕН существовать после завершения. Без него задача провалится.**',
    ] : [
      '## Шаг 1 — Brainstorm',
      '',
      `Прочитай контекст задачи: ${O}/ai/tasks/${issueKey}/context.md`,
      '',
      'Запусти /brainstorm:do со следующим описанием задачи:',
      `"${issueKey}: см. ${O}/ai/tasks/${issueKey}/context.md"`,
      '',
      'Brainstorm должен выявить:',
      '- Суть проблемы',
      '- Варианты реализации (минимум 2)',
      '- Ограничения и риски',
      '- Зависимости',
      '- Рекомендуемый подход',
      '',
      ...reuseFirst(),
      '',
      '## Шаг 2 — Plan',
      '',
      'На основе результатов brainstorm запусти /plan-make:do с описанием выбранного подхода.',
    ];

    return [
      '## Язык',
      noBrainstorm
        ? 'Итоговый plan.md пиши ТОЛЬКО на английском языке.'
        : 'Общайся с пользователем по-русски (brainstorm, обсуждения, вопросы).\nИтоговый plan.md пиши ТОЛЬКО на английском языке.',
      '',
      ...brainstormSection,
      '',
      'План должен содержать секции: Goal, Inputs, Constraints, Assumptions,',
      'Acceptance Criteria Mapping, Implementation Steps (с оценкой сложности),',
      'Affected Files (конкретные пути в репозитории, отдельно: existing to modify / new to create), Validation, Risks, Done Criteria.',
      '',
      '**ВАЖНО: plan.md пишется на английском языке.**',
      '',
      `Используй шаблон: ${O}/ai/templates/plan.md.tmpl`,
      `Сохрани результат в ${O}/ai/tasks/${issueKey}/plan.md.`,
      '',
      '**ФОРМАТ VERDICT:** Строка `## Verdict: APPROVE` или `## Verdict: NEEDS REVISION` — обязательно на ОДНОЙ строке.',
      '',
      '## Шаг 3 — Auto-review',
      '',
      'Запусти агент plan-review для автоматической проверки полноты плана.',
      'Если verdict = NEEDS REVISION — доработай план и пройди review повторно.',
      'Если verdict = APPROVE — план готов.',
      '',
      `Убедись что verdict записан в начало ${O}/ai/tasks/${issueKey}/plan.md.`,
    ];
  },

  planCcConsole({ O, issueKey, engine, launch }) {
    return {
      preparedLine: `\nПромпт подготовлен (cc-thingz flow): ${O}/ai/tasks/${issueKey}/.prompt-plan.md`,
      runHeader: '\nЗапустите Claude Code (убедитесь что cc-thingz установлен):',
      launchLine: `  ${launch}`,
      readLine: `  > Прочитай ${O}/ai/tasks/${issueKey}/.prompt-plan.md и выполни инструкции`,
      skillsHeader: '\nДоступные команды cc-thingz в сессии:',
      skill1: '  /brainstorm:do  — мозговой штурм',
      skill2: '  /plan-make:do   — создание плана',
      skill3: '  plan-review     — агент для автоматической проверки плана',
      afterHeader: '\nПосле завершения:',
      finalizeLine: `  taskctl plan ${issueKey} --finalize`,
    };
  },

  // ── plan (direct prompt, no cc-thingz) ───────────────────────────────────
  planDirect({ O, issueKey }) {
    return [
      '## Язык',
      'Общайся с пользователем по-русски (brainstorm, обсуждения, вопросы).',
      'Итоговый plan.md пиши ТОЛЬКО на английском языке.',
      '',
      '## Фаза 1 — Brainstorm',
      '',
      `Прочитай файл ${O}/ai/tasks/${issueKey}/context.md.`,
      '',
      'Ответь на вопросы:',
      '1. Какую проблему решает эта задача?',
      '2. Какие есть варианты реализации (минимум 2)?',
      '3. Какие ограничения и риски?',
      '4. Какие зависимости?',
      '5. Какой вариант рекомендуешь и почему?',
      '',
      ...reuseFirst(),
      '',
      '## Фаза 2 — Plan',
      '',
      `На основе brainstorm создай файл ${O}/ai/tasks/${issueKey}/plan.md.`,
      '',
      'Обязательные секции: Goal, Inputs, Constraints, Assumptions,',
      'Acceptance Criteria Mapping, Implementation Steps (с оценкой сложности),',
      'Affected Files (конкретные пути, отдельно: existing to modify / new to create), Validation, Risks, Done Criteria.',
      '',
      '**ВАЖНО: plan.md пишется на английском языке.**',
      '',
      `Используй шаблон: ${O}/ai/templates/plan.md.tmpl`,
      '',
      '## Фаза 3 — Self-review',
      '',
      'Проверь план: все AC покрыты? нет scope creep? есть тестирование?',
      '**ФОРМАТ VERDICT:** Строка `## Verdict: APPROVE` или `## Verdict: NEEDS REVISION` — обязательно на ОДНОЙ строке.',
      `Запиши verdict в начало ${O}/ai/tasks/${issueKey}/plan.md.`,
      'Если NEEDS REVISION — доработай и пройди review повторно.',
    ];
  },

  planDirectConsole({ O, issueKey, engine, launch }) {
    return {
      preparedLine: `\nПромпт подготовлен: ${O}/ai/tasks/${issueKey}/.prompt-plan.md`,
      runHeader: `\nЗапустите ${engine}:`,
      launchLine: `  ${launch}`,
      readLine: `  > Прочитай ${O}/ai/tasks/${issueKey}/.prompt-plan.md и выполни инструкции`,
      ccHeader: '\nДля использования cc-thingz (если установлен):',
      ccLine: `  taskctl plan ${issueKey} --engine claude --cc-thingz`,
      afterHeader: '\nПосле завершения:',
      finalizeLine: `  taskctl plan ${issueKey} --finalize`,
    };
  },

  // ── plan-review ──────────────────────────────────────────────────────────
  planReview({ O, issueKey, issueType }) {
    return [
      '## Language',
      'Write review.md in English.',
      '',
      'You are a reviewer. Read:',
      `- ${O}/ai/tasks/${issueKey}/context.md`,
      `- ${O}/ai/tasks/${issueKey}/plan.md`,
      '',
      `## Issue type: ${issueType}`,
      '',
      'Review the plan against these criteria:',
      '1. Completeness: are all acceptance criteria covered?',
      '2. Scope creep: anything beyond the task scope?',
      '3. Over-engineering: is the solution unnecessarily complex?',
      '4. Testing: does the plan include a testing strategy?',
      '5. Dependencies: all accounted for?',
      '6. Risks: all covered?',
      '',
      '## Testing evaluation rules',
      issueType.toLowerCase() === 'bug'
        ? '- For bugfixes: unit/component tests for changed code are sufficient. Missing E2E/integration tests = Suggestion, NOT a blocker.'
        : '- For features: component-level tests are required (Important). Missing E2E tests = Suggestion.',
      '- No testing section at all = Important for any issue type.',
      '- Pre-existing test failures in unrelated modules are NOT a blocker.',
      '',
      `Use template: ${O}/ai/templates/review.md.tmpl`,
      '',
      'Do NOT write files yourself.',
      'Return the full review.md content as your final answer in a single ```md ... ``` block.',
      '',
      '**VERDICT FORMAT:** Line `## Verdict: APPROVE` or `## Verdict: NEEDS REVISION` — must be on a SINGLE line, format `## Verdict: VALUE`.',
      '',
      '## Note on downstream verification',
      'Your findings are INPUT to the orchestrator (the agent running taskctl), not final authority.',
      'Per `ai/rules/engineering.md` § "Cross-Model Review: Orchestrator Verification", the orchestrator will independently verify each Critical / Important finding by reading the cited code before invoking the fix/revise loop.',
      'Cite exact file paths + line numbers so verification is straightforward. Avoid vague claims like "the logic is wrong somewhere" — name the location, name the bug, name the consequence.',
      'If a concern is theoretical (would never trigger given documented invariants), say so explicitly — the orchestrator may legitimately classify it as theoretical and defer.',
    ];
  },

  planReviewConsole({ O, issueKey, engine, launch }) {
    return {
      preparedLine: `\nПромпт подготовлен: ${O}/ai/tasks/${issueKey}/.prompt-review.md`,
      runHeader: `\nЗапустите ${engine} (cross-model review):`,
      launchLine: `  ${launch}`,
      afterHeader: '\nПосле завершения:',
      finalizeLine: `  taskctl plan-review ${issueKey} --finalize`,
    };
  },

  // ── run (execution) ──────────────────────────────────────────────────────
  run({ O, issueKey }) {
    return [
      '## Язык',
      'Общайся с пользователем по-русски. Код, комментарии в коде, коммиты и progress.md — на английском.',
      '',
      '## Правила',
      `- Прочитай ${O}/ai/rules/engineering.md`,
      `- Работай строго по плану из ${O}/ai/tasks/${issueKey}/plan.md`,
      `- После каждого шага обновляй ${O}/ai/tasks/${issueKey}/progress.md`,
      '- Не выходи за scope плана',
      '- Если обнаружишь проблему, не покрытую планом — остановись и сообщи',
      '- **НЕ делай git commit, git push, НЕ создавай PR** — это делает отдельная команда `taskctl publish`',
      '',
      '## Тестирование',
      '- После реализации ОБЯЗАТЕЛЬНО напиши тесты для изменённого кода',
      '- Запусти тесты проекта и убедись что относящиеся к изменениям тесты проходят',
      '- Запусти проверку типов и сборку проекта и убедись что они проходят',
      '',
      '## Начни работу',
      `Прочитай ${O}/ai/tasks/${issueKey}/plan.md и выполняй шаги по порядку.`,
    ];
  },

  runConsole({ O, issueKey, engine, launch, branch }) {
    return {
      preparedLine: `\nПромпт подготовлен: ${O}/ai/tasks/${issueKey}/.prompt-run.md`,
      branchLine: branch ? `  Branch: ${branch}` : null,
      runHeader: `\nЗапустите ${engine}:`,
      launchLine: `  ${launch}`,
      readLine: `  > Прочитай ${O}/ai/tasks/${issueKey}/.prompt-run.md и выполни инструкции`,
      afterHeader: '\nПосле завершения:',
      finalizeLine: `  taskctl run ${issueKey} --finalize`,
    };
  },

  // ── review (final) ───────────────────────────────────────────────────────
  reviewDiffEmpty(integrationBranch) {
    return `- Diff пустой (нет изменений относительно ${integrationBranch})`;
  },
  reviewDiffHint(integrationBranch) {
    return `- Посмотри git diff текущей ветки vs ${integrationBranch}`;
  },

  review({ O, issueKey, issueType, diffInfo }) {
    return [
      '## Language',
      'Write review.md in English.',
      '',
      'You are a senior code reviewer for the project.',
      '',
      '## Files to review',
      `- Plan: ${O}/ai/tasks/${issueKey}/plan.md`,
      `- Progress: ${O}/ai/tasks/${issueKey}/progress.md`,
      diffInfo,
      '',
      `## Issue type: ${issueType}`,
      '',
      '## Criteria',
      '1. All acceptance criteria from plan.md are met?',
      '2. Code follows the project\'s established patterns?',
      '3. No hardcoded credentials or secrets?',
      '4. Types are correct (if a typed language)?',
      '5. Tests exist for changed code (unit and/or component-level)?',
      '',
      '## Missing Coverage evaluation rules',
      issueType.toLowerCase() === 'bug'
        ? '- For bugfixes: missing integration/e2e tests = **Suggestion**, NOT a blocker. Unit/component tests for changed code are sufficient.'
        : '- For features: missing component-level tests = **Important**. Missing e2e tests = **Suggestion**.',
      '- No tests AT ALL for changed code = **Important** for any issue type.',
      '- Pre-existing test failures in unrelated modules are NOT a blocker for this task.',
      '',
      '## Scope boundary (workstream / task scope)',
      'If the plan.md declares explicit scope boundaries (e.g. "Scope boundary" subsection in §Constraints, "out of scope" notes in §Acceptance Criteria, or references to a dependency/ownership matrix that assigns adjacent work to another workstream), respect them.',
      '',
      '- Missing functionality that the plan explicitly declares as belonging to a different workstream (linked by ID / matrix reference / AC note) is **NOT** a pre-publish blocker here. At most, log it under Missing Coverage with a pointer to the owning workstream — never as Critical or Important.',
      '- If you disagree with the boundary, raise it as a **Suggestion** with reasoning. Do not unilaterally escalate to NEEDS WORK — the master plan is authoritative; disputes go through plan revision, not review verdicts.',
      '- What DOES belong in this review regardless of scope: bugs in the code that IS present, broken static checks, security issues visible in the diff, violations of the pre-publish gate from §Done Criteria.',
      '- Per-workstream decomposition for an epic is a deliberate architecture choice. A foundation workstream delivering a primitive + bootstrap consumer, with surface-wide adoption in a downstream workstream, is a valid and common pattern — not a half-finished feature.',
      '',
      `Use template: ${O}/ai/templates/review.md.tmpl`,
      '',
      'Do NOT write files yourself.',
      'Return the full review.md content as your final answer in a single ```md ... ``` block.',
      '',
      '**VERDICT FORMAT:** Line `## Verdict: APPROVE` or `## Verdict: NEEDS WORK` or `## Verdict: REJECT` — must be on a SINGLE line, format `## Verdict: VALUE`.',
      '',
      '## Note on downstream verification',
      'Your findings are INPUT to the orchestrator (the agent running taskctl), not final authority.',
      'Per `ai/rules/engineering.md` § "Cross-Model Review: Orchestrator Verification", the orchestrator will independently verify each Critical / Important finding by reading the cited code before invoking the fix loop.',
      'Cite exact file paths + line numbers so verification is straightforward. Avoid vague claims like "the logic is wrong somewhere" — name the location, name the bug, name the consequence.',
      'If a concern is theoretical (would never trigger given documented invariants), say so explicitly — the orchestrator may legitimately classify it as theoretical and defer.',
      'False positives are costly: each fix iteration consumes ~5–15 min of agent compute. Anchor your claims in concrete evidence.',
    ];
  },

  reviewConsole({ O, issueKey, engine, launch, repoPath }) {
    return {
      preparedLine: `\nПромпт подготовлен: ${O}/ai/tasks/${issueKey}/.prompt-review-final.md`,
      runHeader: `\nЗапустите ${engine} (cross-model review):`,
      launchLine: `  ${launch}`,
      afterHeader: '\nПосле завершения:',
      finalizeLine: `  taskctl review ${issueKey} --finalize`,
    };
  },

  // ── fix ──────────────────────────────────────────────────────────────────
  fix({ O, issueKey }) {
    return [
      '## Язык',
      'Общайся с пользователем по-русски. Код, комментарии, коммиты и progress.md — на английском.',
      '',
      '## Контекст',
      'Код прошёл review и получил замечания. Твоя задача — исправить найденные проблемы.',
      '',
      '## Файлы для чтения',
      `1. Review с замечаниями: ${O}/ai/tasks/${issueKey}/review.md`,
      `2. Orchestrator audit (если есть): ${O}/ai/tasks/${issueKey}/audit-iter*.md — независимая верификация findings + классификация (real bug / theoretical / false positive)`,
      `3. План: ${O}/ai/tasks/${issueKey}/plan.md`,
      `4. Прогресс: ${O}/ai/tasks/${issueKey}/progress.md`,
      `5. Правила: ${O}/ai/rules/engineering.md`,
      '',
      '## Задачи',
      '1. Прочитай review.md — пойми ВСЕ замечания reviewer (Critical, Important, Suggestions)',
      '2. **Если есть audit-iter*.md** — прочти его. Orchestrator уже verified каждое finding и мог пометить некоторые как false-positive (НЕ исправляй те) или добавить bugs которые reviewer пропустил (исправь дополнительно). Audit overrides raw review.md по scope.',
      '3. Исправь КАЖДОЕ confirmed-real Critical и Important замечание. Skip findings помеченные false-positive в audit.',
      '4. Suggestions — на твоё усмотрение (реализуй если разумно)',
      '5. Не ломай то что уже работает',
      '6. Запусти тесты после исправлений',
      `7. Обнови ${O}/ai/tasks/${issueKey}/progress.md — добавь секцию "## Fixes after review"`,
      '',
      '**ПРИНЦИП REUSE-FIRST:** Используй существующие компоненты и утилиты, не создавай лишнего.',
      '',
      '**НЕ делай git commit, git push, НЕ создавай PR** — это делает отдельная команда `taskctl publish`.',
    ];
  },

  fixConsole({ O, issueKey, engine, launch, branch, otherEngine }) {
    return {
      preparedLine: `\nПромпт подготовлен: ${O}/ai/tasks/${issueKey}/.prompt-fix.md`,
      branchLine: branch ? `  Branch: ${branch}` : null,
      runHeader: `\nЗапустите ${engine}:`,
      launchLine: `  ${launch}`,
      readLine: `  > Прочитай ${O}/ai/tasks/${issueKey}/.prompt-fix.md и выполни инструкции`,
      afterHeader: '\nПосле завершения:',
      finalizeLine: `  taskctl fix ${issueKey} --finalize`,
      reReviewLine: `  taskctl review ${issueKey} --engine ${otherEngine}   # повторный review`,
    };
  },

  // ── revise ───────────────────────────────────────────────────────────────
  revise({ O, issueKey }) {
    return [
      '## Язык',
      'Общайся с пользователем по-русски. Итоговый plan.md пиши ТОЛЬКО на английском языке.',
      '',
      '## Контекст',
      'План прошёл review и получил verdict: NEEDS REVISION.',
      'Твоя задача — прочитать замечания reviewer и доработать план.',
      '',
      '## Файлы для чтения',
      `1. Review с замечаниями: ${O}/ai/tasks/${issueKey}/review.md`,
      `2. Orchestrator audit (если есть): ${O}/ai/tasks/${issueKey}/audit-plan-iter*.md ИЛИ "## Orchestrator Audit Notes" в review.md — orchestrator verified каждое finding, мог классифицировать как theoretical/false-positive или добавить пропущенные`,
      `3. Текущий план: ${O}/ai/tasks/${issueKey}/plan.md`,
      `4. Контекст задачи: ${O}/ai/tasks/${issueKey}/context.md`,
      '',
      ...reuseFirst(),
      '',
      '## Задачи',
      '1. Прочитай review.md — пойми ВСЕ замечания reviewer',
      '2. Прочитай текущий plan.md',
      '3. Исправь план, адресовав КАЖДОЕ замечание из review',
      '4. Не удаляй то, что было одобрено — меняй только проблемные части',
      '5. Проведи self-review: все замечания закрыты? нет нового scope creep?',
      '6. Запиши verdict в начало plan.md. **Формат строго** `## Verdict: APPROVE` или `## Verdict: NEEDS REVISION` — H2 heading, ровно два `#`. Не H1 (`#`), не **Verdict:** в metadata bullet.',
      '',
      `Сохрани обновлённый план в ${O}/ai/tasks/${issueKey}/plan.md`,
    ];
  },

  reviseConsole({ O, issueKey, engine, launch, otherEngine }) {
    return {
      preparedLine: `\nПромпт подготовлен: ${O}/ai/tasks/${issueKey}/.prompt-revise.md`,
      runHeader: `\nЗапустите ${engine}:`,
      launchLine: `  ${launch}`,
      readLine: `  > Прочитай ${O}/ai/tasks/${issueKey}/.prompt-revise.md и выполни инструкции`,
      afterHeader: '\nПосле завершения:',
      finalizeLine: `  taskctl revise ${issueKey} --finalize`,
      reReviewLine: `  taskctl plan-review ${issueKey} --engine ${otherEngine}`,
    };
  },

  // ── replan ───────────────────────────────────────────────────────────────
  replan({ O, issueKey, planVersion }) {
    return [
      '## Язык',
      'Общайся с пользователем по-русски. Итоговый plan.md пиши ТОЛЬКО на английском языке.',
      '',
      '## Контекст',
      `Это повторное планирование (replan). Предыдущий план v${planVersion} архивирован.`,
      'Причина replan: изменение scope, зависимостей или контекста.',
      '',
      `Прочитай: ${O}/ai/tasks/${issueKey}/context.md`,
      `Прочитай предыдущий план (если есть): ${O}/ai/tasks/${issueKey}/plan.md`,
      `Прочитай прогресс (если есть): ${O}/ai/tasks/${issueKey}/progress.md`,
      '',
      ...reuseFirst(),
      '',
      '## Задачи',
      '1. Проанализируй что изменилось с момента предыдущего плана',
      '2. Учти уже выполненную работу из progress.md (если есть)',
      '3. Создай обновлённый план с теми же секциями:',
      '   Goal, Inputs, Constraints, Assumptions, AC Mapping,',
      '   Implementation Steps, Affected Files (existing to modify / new to create), Validation, Risks, Done Criteria',
      '4. Проведи self-review и запиши verdict в начало plan.md. **Формат строго** `## Verdict: APPROVE` или `## Verdict: NEEDS REVISION` — H2 heading (ровно два `#`).',
      '',
      `Используй шаблон: ${O}/ai/templates/plan.md.tmpl`,
      `Сохрани результат в ${O}/ai/tasks/${issueKey}/plan.md`,
      '',
      '**ФОРМАТ VERDICT:** Строка `## Verdict: APPROVE` или `## Verdict: NEEDS REVISION` — обязательно на ОДНОЙ строке.',
    ];
  },

  replanConsole({ O, issueKey, engine, launch }) {
    return {
      returnedLine: `\n✓ ${issueKey} возвращён в analysis для replan`,
      promptLine: `  Промпт: ${O}/ai/tasks/${issueKey}/.prompt-plan.md`,
      runHeader: `\nЗапустите ${engine}:`,
      launchLine: `  ${launch}`,
      readLine: `  > Прочитай ${O}/ai/tasks/${issueKey}/.prompt-plan.md и выполни инструкции`,
      afterHeader: '\nПосле завершения:',
      finalizeLine: `  taskctl plan ${issueKey} --finalize`,
    };
  },

  // ── new-project (WP5 Stage 5b) ───────────────────────────────────────────
  // Шаги new-project с участием движка. Каждый возвращает СТРУКТУРИРОВАННЫЙ JSON
  // (валидируется newproject-schema.mjs) и пишет по-английски (I-10): артефакты
  // (brainstorm.md/proposal.md/...) всегда на английском, выбор языка пакета их
  // не меняет. `flowDir` — абсолютный путь каталога потока в ЭТОМ воркспейсе.
  newProjectBrainstorm({ flowDir, idea, slug }) {
    return [
      '## Language',
      '**Write ALL output in English** (this artifact is reviewed in English).',
      '',
      '## Задача — брейншторм нового проекта по идее',
      '',
      `Slug проекта: ${slug}`,
      `Идея: "${idea}"`,
      '',
      'Сделай ОДИН структурированный проход брейншторма (без многоходового диалога —',
      'пользователь ответит, отредактировав артефакт и перезапустив команду). Выяви:',
      '- Открытые вопросы, требующие решения человека (scope, аудитория, ограничения).',
      '- Допущения, которые ты делаешь.',
      '- Возможные варианты реализации (минимум два разных направления).',
      '',
      '## Формат вывода — один fenced JSON-конверт',
      'Выдай РОВНО ОДИН блок ```json такой формы:',
      '```json',
      '{',
      '  "questions": ["...", "..."],',
      '  "assumptions": ["...", "..."],',
      '  "options": ["...", "..."]',
      '}',
      '```',
      'Все строки ДОЛЖНЫ быть на английском. `questions` и `options` вместе непусты.',
      `taskctl рендерит ${flowDir}/brainstorm.md ИЗ этого конверта.`,
    ];
  },

  newProjectBrainstormConsole({ flowDir }) {
    return {
      preparedLine: `\nBrainstorm artifact: ${flowDir}/brainstorm.md`,
      editHeader: '\nReview + edit the brainstorm, then re-invoke to continue:',
      editLine: `  (edit ${flowDir}/brainstorm.md — answer the questions)`,
    };
  },

  newProjectProposal({ flowDir, idea, slug }) {
    return [
      '## Language',
      '**Write ALL output in English.**',
      '',
      '## Задача — предложить стек / архитектуру',
      '',
      `Slug проекта: ${slug}`,
      `Идея: "${idea}"`,
      `Прочитай отредактированный брейншторм ${flowDir}/brainstorm.md и предложи`,
      'конкретные варианты стека/архитектуры. Дай МИНИМУМ ДВА варианта с trade-offs',
      'и порекомендуй один.',
      '',
      '## Формат вывода — один fenced JSON-конверт',
      '```json',
      '{',
      '  "recommended": "<id рекомендованного варианта>",',
      '  "options": [',
      '    { "id": "a", "stack": "...", "rationale": "..." },',
      '    { "id": "b", "stack": "...", "rationale": "..." }',
      '  ]',
      '}',
      '```',
      'Все строки на английском. `recommended` ДОЛЖЕН совпадать с одним `id`. taskctl',
      `рендерит ${flowDir}/proposal.md ИЗ этого конверта.`,
    ];
  },

  newProjectProposalConsole({ flowDir }) {
    return {
      preparedLine: `\nProposal artifact: ${flowDir}/proposal.md`,
      chooseHeader: '\nPick an option (re-invoke; --yes auto-picks the recommended one).',
    };
  },

  newProjectScaffold({ flowDir, idea, slug, chosenOption }) {
    return [
      '## Language',
      '**Write ALL output in English.**',
      '',
      '## Задача — подготовить PRINT-ONLY план скаффолда',
      '',
      `Slug проекта: ${slug}`,
      `Идея: "${idea}"`,
      `Выбранный вариант: ${chosenOption}`,
      `Прочитай ${flowDir}/proposal.md. Выдай ТОЧНЫЕ команды нативных генераторов,`,
      'которые ПОЛЬЗОВАТЕЛЬ запустит сам (напр. `npm create vite@latest <dir>`,',
      '`cargo new <dir>`, ...), плюс предполагаемое дерево файлов верхнего уровня.',
      '',
      '**Эти команды ПЕЧАТАЮТСЯ для пользователя — taskctl НИКОГДА их не выполняет.**',
      '',
      '## Формат вывода — один fenced JSON-конверт',
      '```json',
      '{',
      '  "commands": ["npm create vite@latest . -- --template react-ts", "..."],',
      '  "fileTree": ["src/", "src/main.tsx", "package.json"]',
      '}',
      '```',
      'Все строки на английском. `commands` непуст. taskctl рендерит',
      `${flowDir}/scaffold-plan.md ИЗ этого конверта.`,
    ];
  },

  newProjectScaffoldConsole({ flowDir }) {
    return {
      preparedLine: `\nScaffold plan: ${flowDir}/scaffold-plan.md`,
      runHeader: '\nRun the printed commands yourself, then `git init`, then re-invoke:',
    };
  },

  newProjectBacklog({ flowDir, idea, slug }) {
    return [
      '## Language',
      '**Write ALL output in English** (task context.md files are English).',
      '',
      '## Задача — разложить на стартовый бэклог',
      '',
      `Slug проекта: ${slug}`,
      `Идея: "${idea}"`,
      `Прочитай ${flowDir}/proposal.md и ${flowDir}/scaffold-plan.md. Разбей работу`,
      'на небольшой упорядоченный бэклог первых задач (обычно 3–6).',
      '',
      '## Формат вывода — один fenced JSON-конверт',
      '```json',
      '{',
      '  "tasks": [',
      '    { "slug": "short-label", "title": "...", "desc": "..." }',
      '  ]',
      '}',
      '```',
      'Все строки на английском. Каждый `slug` — короткая kebab-метка (taskctl',
      `префиксует её как <project>-NN-<slug>). Минимум одна задача.`,
    ];
  },

  newProjectBacklogConsole({ count }) {
    return {
      preparedLine: `\nBacklog: ${count} task(s) seeded under the project's ai/tasks/`,
    };
  },

  // ── shared console strings ───────────────────────────────────────────────
  codexAutoSaveNote(cmd) {
    return `  Note: for auto-save into review.md, prefer: taskctl do ${cmd}`;
  },
};
