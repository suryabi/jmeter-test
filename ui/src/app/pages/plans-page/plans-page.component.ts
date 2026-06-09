import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RunnerService } from '../../core/services/runner.service';
import { PlansPanelComponent } from '../../components/plans-panel/plans-panel.component';
import { TopbarComponent } from '../../components/topbar/topbar.component';
import { MessageModule } from 'primeng/message';

@Component({
  selector: 'app-plans-page',
  standalone: true,
  imports: [CommonModule, TopbarComponent, PlansPanelComponent, MessageModule],
  templateUrl: './plans-page.component.html',
  styleUrl: './plans-page.component.scss'
})
export class PlansPageComponent implements OnInit {
  private readonly runner = inject(RunnerService);

  apiOnline = false;
  error = '';

  ngOnInit(): void {
    this.runner.health().subscribe({
      next: () => (this.apiOnline = true),
      error: () => {
        this.apiOnline = false;
        this.error = 'Runner API is offline. Start it with: npm start';
      }
    });
  }
}
