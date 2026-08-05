import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { PlanInsightsEditorComponent } from '../../components/plan-insights-editor/plan-insights-editor.component';
import { MessageModule } from 'primeng/message';

@Component({
  selector: 'app-plan-insights-page',
  standalone: true,
  imports: [CommonModule, RouterLink, TopbarComponent, PlanInsightsEditorComponent, MessageModule],
  templateUrl: './plan-insights-page.component.html',
  styleUrl: './plan-insights-page.component.scss'
})
export class PlanInsightsPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);

  readonly planFile = signal('');
  readonly error = signal('');

  ngOnInit(): void {
    this.route.paramMap.subscribe((params) => {
      const raw = params.get('planFile')?.trim() ?? '';
      if (!raw) {
        this.planFile.set('');
        this.error.set('No plan was specified.');
        return;
      }
      this.error.set('');
      this.planFile.set(decodeURIComponent(raw));
    });
  }
}
