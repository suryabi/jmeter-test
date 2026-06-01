import {
  AfterViewInit,
  Component,
  ElementRef,
  Input,
  OnChanges,
  SimpleChanges,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';

/** Pixels from bottom still treated as "following" the live stream. */
const SCROLL_BOTTOM_THRESHOLD_PX = 48;

@Component({
  selector: 'app-log-console',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './log-console.component.html',
  styleUrl: './log-console.component.scss'
})
export class LogConsoleComponent implements OnChanges, AfterViewInit {
  @Input() lines: string[] = [];
  @Input() autoScroll = true;
  /** When this changes (e.g. run id), tail-follow resets and view scrolls to bottom. */
  @Input() scrollKey = '';

  @ViewChild('viewport') viewport?: ElementRef<HTMLDivElement>;

  /** User is following the live tail; updated on scroll, reset on scrollKey change. */
  private followTail = true;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['scrollKey'] && !changes['scrollKey'].firstChange) {
      this.followTail = true;
      this.scheduleScrollToBottom(true);
    }

    if (changes['lines'] && this.autoScroll) {
      this.scheduleScrollToBottom(this.followTail);
    }
  }

  ngAfterViewInit(): void {
    if (this.autoScroll && this.lines.length > 0) {
      this.followTail = true;
      this.scheduleScrollToBottom(true);
    }
  }

  onViewportScroll(): void {
    this.followTail = this.isNearBottom();
  }

  clear(): void {
    this.lines = [];
    this.followTail = true;
  }

  private scheduleScrollToBottom(shouldFollow: boolean): void {
    if (!shouldFollow || !this.autoScroll) {
      return;
    }

    queueMicrotask(() => {
      requestAnimationFrame(() => {
        if (!this.autoScroll || !shouldFollow) {
          return;
        }
        if (!this.followTail) {
          return;
        }
        this.scrollToBottom();
      });
    });
  }

  private isNearBottom(): boolean {
    const el = this.viewport?.nativeElement;
    if (!el) {
      return true;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD_PX;
  }

  private scrollToBottom(): void {
    const el = this.viewport?.nativeElement;
    if (el) {
      el.scrollTop = el.scrollHeight;
      this.followTail = true;
    }
  }
}
