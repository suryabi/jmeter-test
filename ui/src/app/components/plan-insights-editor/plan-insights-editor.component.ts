import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { ProgressSpinnerModule } from 'primeng/progressspinner';
import { TagModule } from 'primeng/tag';
import { TextareaModule } from 'primeng/textarea';
import { RunnerService } from '../../core/services/runner.service';
import { InsightFieldConfig } from '../../core/models/runner.models';
import {
  InsightGuideTemplate,
  PlanInsightsGuideComponent
} from '../plan-insights-guide/plan-insights-guide.component';

interface EditableInsightField extends InsightFieldConfig {
  key: string;
}

@Component({
  selector: 'app-plan-insights-editor',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    DialogModule,
    InputTextModule,
    TextareaModule,
    MessageModule,
    ProgressSpinnerModule,
    TagModule,
    PlanInsightsGuideComponent
  ],
  templateUrl: './plan-insights-editor.component.html',
  styleUrl: './plan-insights-editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PlanInsightsEditorComponent {
  private readonly runner = inject(RunnerService);

  readonly planFile = input<string | null>(null);
  readonly saved = output<void>();

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly fields = signal<EditableInsightField[]>([]);
  readonly hasInsightBlock = signal(false);
  readonly guideOpen = signal(false);
  readonly selectedRuleKey = signal<string | null>(null);

  readonly ruleCount = computed(() => this.fields().length);

  readonly selectedField = computed(() => {
    const key = this.selectedRuleKey();
    if (!key) return null;
    return this.fields().find((field) => field.key === key) ?? null;
  });

  readonly selectedRuleIndex = computed(() => {
    const key = this.selectedRuleKey();
    if (!key) return -1;
    return this.fields().findIndex((field) => field.key === key);
  });

  readonly templates: InsightGuideTemplate[] = [
    {
      id: 'scope-open',
      label: 'Open entity scope',
      description:
        'kind=scope_open entity=request match=`Request (\\d+)/(\\d+) Creation Started` index=$1 total=$2 status=started stepLabel=`Request $1/$2 started` stepStatus=info'
    },
    {
      id: 'capture-field',
      label: 'Capture entity field',
      description:
        'kind=field entity=request match=`Customer Name:\\s*(.+)` set=customerName group=1 onlyIfEmpty=true'
    },
    {
      id: 'workflow-step',
      label: 'Workflow step',
      description:
        'kind=step scope=request match=`Create Request Status PostProcessor: Status:\\s*SUCCESS` label=`Request $index/$total created` status=success'
    },
    {
      id: 'run-field',
      label: 'Run-level field',
      description:
        'kind=run_field match=`Date Range:\\s*(\\d{4}-\\d{2}-\\d{2})\\s+to\\s+(\\d{4}-\\d{2}-\\d{2})` set=dateRange template=`$1 to $2`'
    },
    {
      id: 'summary',
      label: 'Summary counts',
      description: 'kind=summary entity=request field=status counts=created,failed,skipped,started'
    },
    {
      id: 'ui-list',
      label: 'UI entity list',
      description: 'kind=ui entity=request list=true title=`Request $index/$total`'
    }
  ];

  private loadedForPlan: string | null = null;

  constructor() {
    effect(() => {
      const planFile = this.planFile();
      untracked(() => this.loadForPlan(planFile));
    });
  }

  openGuide(): void {
    this.guideOpen.set(true);
  }

  closeGuide(): void {
    this.guideOpen.set(false);
  }

  selectRule(key: string): void {
    this.selectedRuleKey.set(key);
  }

  isSelected(key: string): boolean {
    return this.selectedRuleKey() === key;
  }

  addField(description?: string): void {
    const index = this.fields().length + 1;
    const id = `insightRule${index}`;
    const key = crypto.randomUUID();
    this.fields.update((fields) => [
      ...fields,
      {
        key,
        id,
        name: id,
        description:
          description ??
          'kind=step scope=run match=`example log line` label=`Example workflow step` status=info'
      }
    ]);
    this.selectedRuleKey.set(key);
    this.clearMessages();
  }

  addTemplate(template: InsightGuideTemplate): void {
    this.addField(template.description);
    this.closeGuide();
  }

  duplicateField(): void {
    const source = this.selectedField();
    if (!source) return;

    const index = this.fields().length + 1;
    const id = `${source.id}Copy${index}`;
    const key = crypto.randomUUID();
    this.fields.update((fields) => [
      ...fields,
      {
        key,
        id,
        name: id,
        description: source.description
      }
    ]);
    this.selectedRuleKey.set(key);
    this.clearMessages();
  }

  removeSelectedField(): void {
    const key = this.selectedRuleKey();
    if (!key) return;

    const fields = this.fields();
    const index = fields.findIndex((field) => field.key === key);
    if (index < 0) return;

    const nextFields = fields.filter((field) => field.key !== key);
    this.fields.set(nextFields);
    this.syncSelection(nextFields[index]?.key ?? nextFields[index - 1]?.key ?? null);
    this.clearMessages();
  }

  moveSelectedField(direction: -1 | 1): void {
    const key = this.selectedRuleKey();
    if (!key) return;

    this.fields.update((fields) => {
      const index = fields.findIndex((field) => field.key === key);
      if (index < 0) return fields;
      const target = index + direction;
      if (target < 0 || target >= fields.length) return fields;
      const next = [...fields];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
    this.clearMessages();
  }

  onFieldIdChange(field: EditableInsightField, value: string): void {
    const id = value.trim();
    field.id = id;
    field.name = id;
    this.clearMessages();
  }

  ruleKind(description: string): string | null {
    const match = String(description || '').match(/\bkind=([a-z_]+)/i);
    return match ? match[1].toLowerCase() : null;
  }

  ruleEntity(description: string): string | null {
    const match = String(description || '').match(/\bentity=([a-z_]+)/i);
    return match ? match[1].toLowerCase() : null;
  }

  ruleScope(description: string): string | null {
    const match = String(description || '').match(/\bscope=([a-z_]+)/i);
    return match ? match[1].toLowerCase() : null;
  }

  rulePreview(description: string): string {
    const text = String(description || '').trim();
    const match = text.match(/match=`([^`]*)`/);
    if (match?.[1]) {
      return this.truncatePreview(match[1]);
    }
    const label = text.match(/label=`([^`]*)`/);
    if (label?.[1]) {
      return this.truncatePreview(label[1]);
    }
    return this.truncatePreview(text.replace(/\bkind=[a-z_]+\s*/i, ''));
  }

  kindSeverity(kind: string | null): 'info' | 'success' | 'warn' | 'secondary' | 'contrast' {
    switch (kind) {
      case 'scope_open':
        return 'info';
      case 'step':
        return 'success';
      case 'field':
      case 'run_field':
        return 'warn';
      case 'summary':
        return 'contrast';
      case 'ui':
        return 'secondary';
      default:
        return 'secondary';
    }
  }

  kindLabel(kind: string | null): string {
    if (!kind) return 'unknown';
    return kind.replace(/_/g, ' ');
  }

  save(): void {
    const planFile = this.planFile();
    if (!planFile) return;

    this.saving.set(true);
    this.clearMessages();

    const selectedId = this.selectedField()?.id ?? null;
    const payload: InsightFieldConfig[] = this.fields().map((field) => ({
      id: field.id.trim(),
      name: field.id.trim(),
      description: field.description.trim()
    }));

    this.runner.savePlanInsights(planFile, payload).subscribe({
      next: (response) => {
        this.saving.set(false);
        this.hasInsightBlock.set(response.hasInsightBlock);
        const fields = this.toEditableFields(response.fields);
        this.fields.set(fields);
        const preferredKey =
          fields.find((field) => field.id === selectedId)?.key ?? fields[0]?.key ?? null;
        this.syncSelection(preferredKey);
        this.loadedForPlan = planFile;
        this.notice.set('Insight rules saved to the plan JMX.');
        this.saved.emit();
      },
      error: (err) => {
        this.saving.set(false);
        this.error.set(err?.error?.error || err?.message || 'Failed to save insight fields');
      }
    });
  }

  private truncatePreview(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length <= 88) return trimmed;
    return `${trimmed.slice(0, 88)}…`;
  }

  private clearMessages(): void {
    this.notice.set('');
    this.error.set('');
  }

  private syncSelection(preferredKey: string | null = null): void {
    const fields = this.fields();
    if (!fields.length) {
      this.selectedRuleKey.set(null);
      return;
    }

    const key = preferredKey ?? this.selectedRuleKey();
    if (key && fields.some((field) => field.key === key)) {
      this.selectedRuleKey.set(key);
      return;
    }

    this.selectedRuleKey.set(fields[0].key);
  }

  private loadForPlan(planFile: string | null): void {
    if (!planFile) {
      this.loadedForPlan = null;
      this.fields.set([]);
      this.hasInsightBlock.set(false);
      this.selectedRuleKey.set(null);
      this.loading.set(false);
      this.clearMessages();
      return;
    }

    if (planFile === this.loadedForPlan) {
      return;
    }

    this.loading.set(true);
    this.clearMessages();

    this.runner.getPlanInsights(planFile).subscribe({
      next: (response) => {
        this.loadedForPlan = planFile;
        this.hasInsightBlock.set(response.hasInsightBlock);
        const fields = this.toEditableFields(response.fields);
        this.fields.set(fields);
        this.syncSelection(fields[0]?.key ?? null);
        this.loading.set(false);
      },
      error: (err) => {
        this.loadedForPlan = null;
        this.fields.set([]);
        this.selectedRuleKey.set(null);
        this.loading.set(false);
        this.error.set(err?.error?.error || err?.message || 'Failed to load insight fields');
      }
    });
  }

  private toEditableFields(fields: InsightFieldConfig[]): EditableInsightField[] {
    return fields.map((field) => ({
      ...field,
      key: crypto.randomUUID()
    }));
  }
}
