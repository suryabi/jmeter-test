import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface InsightGuideTemplate {
  id: string;
  label: string;
  description: string;
}

@Component({
  selector: 'app-plan-insights-guide',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './plan-insights-guide.component.html',
  styleUrl: './plan-insights-guide.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class PlanInsightsGuideComponent {
  readonly templates = input<InsightGuideTemplate[]>([]);
  readonly addTemplate = output<InsightGuideTemplate>();
}
