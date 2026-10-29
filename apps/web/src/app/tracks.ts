import { Component, input } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DragDropModule, CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import type { TrackChoice, Track } from '@muxplorer/shared';
import { Icon } from './icon';
import { codecFlag, languageFlag } from './media-flags';
export interface EditableTrack extends TrackChoice {
  metadata: Track;
  sourceName: string;
}
@Component({
  selector: 'mx-tracks',
  standalone: true,
  imports: [FormsModule, DragDropModule, Icon],
  template: ` @for (group of groups; track group.type) {
    <details class="track-group" open>
      <summary>
        {{ group.label }}
        <span
          >{{ groupTracks(group.type).length }}
          {{ groupTracks(group.type).length === 1 ? 'pista' : 'pistas' }}</span
        >
      </summary>
      <div class="track-table">
        <div class="track-header">
          <span></span><span>Pista / códec</span><span>Logo</span><span>Nombre</span
          ><span>Idioma</span><span title="Predeterminada">Default</span
          ><span title="Forzada">Forced</span>
        </div>
        <div cdkDropList (cdkDropListDropped)="drop($event, group.type)">
          @for (track of groupTracks(group.type); track track.source + ':' + track.id) {
            <div class="track-row" cdkDrag [class.track-disabled]="!track.enabled">
              <div class="track-select">
                <button class="drag-handle" cdkDragHandle title="Arrastrar para ordenar">
                  <mx-icon name="GripVertical" [size]="15" /></button
                ><input
                  type="checkbox"
                  [(ngModel)]="track.enabled"
                  [attr.aria-label]="'Conservar pista ' + track.id + ' de ' + track.sourceName"
                />
              </div>
              <div class="track-description">
                <b>{{ track.metadata.codec }}</b>
                <div class="track-codec-details">
                  @if (track.metadata.channels) {
                    <span>{{ track.metadata.channels }} canales</span>
                  }
                  @if (track.metadata.resolution) {
                    <span>{{ track.metadata.resolution }}</span>
                  }
                </div>
              </div>
              <div class="track-codec-logo">
                @if (codecFlag(track.metadata); as flag) {
                  <img class="codec-flag" [src]="flag" [alt]="track.metadata.codec" />
                } @else {
                  <mx-icon [name]="group.icon" [size]="24" />
                }
              </div>
              <input
                [(ngModel)]="track.name"
                placeholder="Nombre de pista"
                [disabled]="!track.enabled"
                aria-label="Nombre de pista"
              />
              <div class="track-language">
                @if (languageFlag(track.language); as flag) {
                  <img class="language-flag" [src]="flag" alt="" [title]="track.language" />
                } @else {
                  <mx-icon name="Globe" [size]="20" title="Idioma sin país asociado" />
                }
                <input
                  [(ngModel)]="track.language"
                  placeholder="und"
                  [disabled]="!track.enabled"
                  aria-label="Idioma BCP 47"
                  maxlength="35"
                />
              </div>
              <input
                type="checkbox"
                [(ngModel)]="track.default"
                [disabled]="!track.enabled"
                aria-label="Pista predeterminada"
              /><input
                type="checkbox"
                [(ngModel)]="track.forced"
                [disabled]="!track.enabled"
                aria-label="Pista forzada"
              />
            </div>
          }
        </div>
      </div>
    </details>
  }`,
})
export class Tracks {
  readonly tracks = input.required<EditableTrack[]>();
  readonly codecFlag = codecFlag;
  readonly languageFlag = languageFlag;
  readonly groups = [
    { type: 'video', label: 'Vídeo', icon: 'Film' },
    { type: 'audio', label: 'Audio', icon: 'FileAudio' },
    { type: 'subtitles', label: 'Subtítulos', icon: 'Captions' },
  ] as const;
  groupTracks(type: Track['type']) {
    return this.tracks().filter((track) => track.metadata.type === type);
  }
  drop(event: CdkDragDrop<EditableTrack[]>, type: Track['type']) {
    const group = this.groupTracks(type);
    moveItemInArray(group, event.previousIndex, event.currentIndex);
    let index = 0;
    this.tracks().forEach((track, position, tracks) => {
      if (track.metadata.type === type) tracks[position] = group[index++];
    });
  }
}
