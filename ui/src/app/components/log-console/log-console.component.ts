import {
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-log-console',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './log-console.component.html',
  styleUrl: './log-console.component.scss'
})
export class LogConsoleComponent implements OnChanges, OnDestroy {
  @Input() lines: string[] = [];
  @Input() autoScroll = true;

  @ViewChild('viewport') viewport?: ElementRef<HTMLDivElement>;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['lines'] && this.autoScroll) {
      queueMicrotask(() => this.scrollToBottom());
    }
  }

  ngOnDestroy(): void {
    // no-op
  }

  clear(): void {
    this.lines = [];
  }

  private scrollToBottom(): void {
    const el = this.viewport?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }
}
