import { NgZone, OnDestroy, Output, ViewChild } from '@angular/core';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, Input, OnChanges, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { CDNLine, CDNLogLink, CDNStreamFilter, PipelineStatus, SpawnInfo } from 'app/model/pipeline.model';
import { WorkflowNodeJobRun } from 'app/model/workflow.run.model';
import { WorkflowService } from 'app/service/workflow/workflow.service';
import { AutoUnsubscribe } from 'app/shared/decorator/autoUnsubscribe';
import { DurationService } from 'app/shared/duration/duration.service';
import { ProjectState } from 'app/store/project.state';
import { WorkflowState } from 'app/store/workflow.state';
import * as moment from 'moment';
import { Observable, Subscription } from 'rxjs';
import { delay, retryWhen } from 'rxjs/operators';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import { WorkflowRunJobVariableComponent } from '../variables/job.variables.component';

export enum DisplayMode {
    ANSI = 'ansi',
    HTML = 'html',
}

export enum ScrollTarget {
    BOTTOM = 'bottom',
    TOP = 'top',
}

export class Tab {
    name: string;
}

export class LogBlock {
    id: number;
    name: string;
    lines: Array<CDNLine>;
    endLines: Array<CDNLine>;
    open: boolean;
    firstDisplayedLineNumber: number;
    totalLinesCount: number;
    link: CDNLogLink;
    startDate: moment.Moment;
    duration: string;
    optional: boolean;
    disabled: boolean;
    failed: boolean;

    constructor(name: string) {
        this.name = name;
        this.lines = [];
        this.endLines = [];
        this.firstDisplayedLineNumber = 0;
        this.totalLinesCount = 0;
    }

    clickOpen(): void {
        this.open = !this.open;
    }
}

@Component({
    selector: 'app-workflow-run-job',
    templateUrl: './workflow-run-job.html',
    styleUrls: ['workflow-run-job.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
@AutoUnsubscribe()
export class WorkflowRunJobComponent implements OnInit, OnChanges, OnDestroy {
    readonly initLoadLinesCount = 5;
    readonly expandLoadLinesCount = 20;
    readonly displayModes = DisplayMode;
    readonly scrollTargets = ScrollTarget

    @ViewChild('jobVariable') jobVariable: WorkflowRunJobVariableComponent;

    @Input() nodeJobRun: WorkflowNodeJobRun;
    @Output() onScroll = new EventEmitter<ScrollTarget>();

    mode = DisplayMode.ANSI;
    tabs: Array<Tab>;
    currentTabIndex = 0;
    pollingSpawnInfoSubscription: Subscription;
    pollingLogLinesSubscription: Subscription;
    websocket: WebSocketSubject<any>;
    websocketSubscription: Subscription;
    previousNodeJobRun: WorkflowNodeJobRun;
    steps: Array<LogBlock>;
    services: Array<LogBlock>;

    constructor(
        private _cd: ChangeDetectorRef,
        private _store: Store,
        private _workflowService: WorkflowService,
        private _ngZone: NgZone,
        private _router: Router
    ) { }

    ngOnInit(): void { }

    ngOnDestroy(): void { } // Should be set to use @AutoUnsubscribe with AOT

    ngOnChanges(): void {
        if (!this.nodeJobRun) { return; }

        if (this.previousNodeJobRun && this.previousNodeJobRun.id !== this.nodeJobRun.id) {
            this.reset();
        }

        if (this.previousNodeJobRun) {
            let statusChanged = this.previousNodeJobRun.status !== this.nodeJobRun.status;
            let requirementsChanged = this.previousNodeJobRun.job.action.requirements?.length
                !== this.nodeJobRun.job.action.requirements?.length;
            let stepStatusChanged = this.previousNodeJobRun.job.step_status?.length !== this.nodeJobRun.job.step_status?.length;
            let lastStepStatusChanged = this.previousNodeJobRun.job.step_status && this.nodeJobRun.job.step_status &&
                this.previousNodeJobRun.job.step_status.length === this.nodeJobRun.job.step_status.length &&
                this.previousNodeJobRun.job.step_status.length > 0 &&
                (this.previousNodeJobRun.job.step_status[this.previousNodeJobRun.job.step_status.length - 1].status
                    !== this.nodeJobRun.job.step_status[this.nodeJobRun.job.step_status.length - 1].status);
            let parametersChanged = this.previousNodeJobRun?.parameters?.length !== this.nodeJobRun?.parameters?.length;
            let shouldUpdate = statusChanged || requirementsChanged || stepStatusChanged || parametersChanged || lastStepStatusChanged;
            if (!shouldUpdate) {
                return;
            }
        }
        this.previousNodeJobRun = this.nodeJobRun;

        let requirements = (this.nodeJobRun.job.action.requirements ? this.nodeJobRun.job.action.requirements : []);
        if (!this.tabs) {
            this.tabs = [{ name: 'Job' }].concat(requirements
                .filter(r => r.type === 'service').map(r => <Tab>{ name: r.name }));
        }
        if (!this.services) {
            this.services = requirements.filter(r => r.type === 'service').map(r => new LogBlock(r.name));
        }

        if (!this.steps) {
            this.steps = [new LogBlock('Informations')];
        }
        let steps = (this.nodeJobRun.job.action.actions ? this.nodeJobRun.job.action.actions : []);
        steps.forEach((a, i) => {
            if (!this.nodeJobRun.job.step_status || !this.nodeJobRun.job.step_status[i]) {
                return;
            }
            let exists = this.steps[i + 1];
            if (!exists) {
                let block = new LogBlock(a.step_name ? a.step_name : a.name);
                block.disabled = !a.enabled;
                block.optional = a.optional;
                this.steps.push(block);
            }
            this.steps[i + 1].failed = PipelineStatus.FAIL === this.nodeJobRun.job.step_status[i].status;
        });
        this.computeStepsDuration();

        this._cd.markForCheck();

        this.loadDataForCurrentTab();
    }

    loadDataForCurrentTab(): void {
        this.stopPollingSpawnInfo();
        this.stopWebsocketSubscription();

        if (this.currentTabIndex === 0) {
            this.startPollingSpawnInfo(); // async
            this.loadEndedSteps(); // async
            this.startListenLastActiveStep(); // async
        } else {
            this.loadOrListenService(); // async
        }
    }

    reset(): void {
        this.previousNodeJobRun = null;
        this.tabs = null;
        this.steps = null;
        this.services = null;
        this.currentTabIndex = 0;
        this.stopPollingSpawnInfo();
        this.stopWebsocketSubscription();
    }

    selectTab(i: number): void {
        this.currentTabIndex = i;
        this._cd.markForCheck();
        this.loadDataForCurrentTab();
    }

    clickMode(mode: DisplayMode): void {
        this.mode = mode;
        this._cd.markForCheck();
    }

    async loadEndedSteps() {
        let projectKey = this._store.selectSnapshot(ProjectState.projectSnapshot).key;
        let workflowName = this._store.selectSnapshot(WorkflowState.workflowSnapshot).name;
        let nodeRunID = this._store.selectSnapshot(WorkflowState).workflowNodeRun.id;
        let nodeJobRunID = this._store.selectSnapshot(WorkflowState.getSelectedWorkflowNodeJobRun()).id;

        if (!this.nodeJobRun.job.step_status) {
            return;
        }

        for (let i = 1; i < this.steps.length; i++) {
            // We want to load initial data (first 5 and last 5 lines) for ended steps never loaded
            if (PipelineStatus.isActive(this.nodeJobRun.job.step_status[i - 1].status)) {
                break;
            }
            if (this.steps[i].link) {
                continue;
            }
            if (!this.nodeJobRun.job.action.actions[i - 1].enabled) {
                continue;
            }

            this.steps[i].link = await this._workflowService.getStepLink(projectKey, workflowName, nodeRunID, nodeJobRunID, i - 1)
                .toPromise();
            let results = await Promise.all([
                this._workflowService.getLogLines(this.steps[i].link, { limit: `${this.initLoadLinesCount}` }).toPromise(),
                this._workflowService.getLogLines(this.steps[i].link, { offset: `-${this.initLoadLinesCount}` }).toPromise()
            ]);
            this.steps[i].lines = results[0].lines;
            this.steps[i].endLines = results[1].lines.filter(l => !results[0].lines.find(line => line.number === l.number));
            this.steps[i].totalLinesCount = results[0].totalCount;
            this.steps[i].open = true;
        }

        this.computeStepFirstLineNumbers();

        this._cd.markForCheck();
    }

    clickScroll(target: ScrollTarget): void { this.onScroll.emit(target); }

    stopPollingSpawnInfo(): void {
        if (this.pollingSpawnInfoSubscription) { this.pollingSpawnInfoSubscription.unsubscribe(); }
    }

    async startPollingSpawnInfo() {
        let projectKey = this._store.selectSnapshot(ProjectState.projectSnapshot).key;
        let workflowName = this._store.selectSnapshot(WorkflowState.workflowSnapshot).name;
        let nodeRunID = this._store.selectSnapshot(WorkflowState).workflowNodeRun.id;
        let nodeJobRunID = this._store.selectSnapshot(WorkflowState.getSelectedWorkflowNodeJobRun()).id;
        let runNumber = this._store.selectSnapshot(WorkflowState).workflowNodeRun.num;

        let callback = (is: Array<SpawnInfo>) => {
            this.steps[0].lines = is.filter(i => !!i.user_message).map((info, i) => <CDNLine>{
                number: i,
                value: `${info.user_message}\n`,
                extra: [moment(info.api_time).format('YYYY-MM-DD hh:mm:ss Z')]
            });
            this.steps[0].totalLinesCount = this.steps[0].lines.length;
            this.steps[0].open = true;
            this.computeStepFirstLineNumbers();
            this._cd.markForCheck();
        }

        if (PipelineStatus.isDone(this.nodeJobRun.status)) {
            callback(this.nodeJobRun.spawninfos);
            return;
        }

        let result = await this._workflowService.getNodeJobRunInfo(projectKey, workflowName,
            runNumber, nodeRunID, nodeJobRunID).toPromise();
        callback(result);

        this._ngZone.runOutsideAngular(() => {
            this.pollingSpawnInfoSubscription = Observable.interval(2000)
                .mergeMap(_ => this._workflowService.getNodeJobRunInfo(projectKey, workflowName,
                    runNumber, nodeRunID, nodeJobRunID)).subscribe(spawnInfos => {
                        this._ngZone.run(() => { callback(spawnInfos); });
                    });
        });
    }

    trackStepElement(index: number, element: LogBlock) { return index; }

    trackLineElement(index: number, element: CDNLine) { return element ? element.number : null; }

    computeStepFirstLineNumbers(): void {
        let nestFirstLineNumber = 1;
        for (let i = 0; i < this.steps.length; i++) {
            this.steps[i].firstDisplayedLineNumber = nestFirstLineNumber;
            nestFirstLineNumber += this.steps[i].totalLinesCount + 1; // add one more line for step name
        }
    }

    computeStepsDuration(): void {
        for (let i = 1; i < this.steps.length; i++) {
            if (!this.nodeJobRun.job?.step_status[i - 1]?.status) {
                continue;
            }
            let stepStatus = this.nodeJobRun.job.step_status[i - 1];
            if (PipelineStatus.neverRun(stepStatus.status) || !stepStatus.start) {
                continue;
            }
            this.steps[i].startDate = moment(stepStatus.start);
            if (stepStatus.done && stepStatus.done !== '0001-01-01T00:00:00Z') {
                this.steps[i].duration = DurationService.duration(this.steps[i].startDate.toDate(), moment(stepStatus.done).toDate());
            }
        }
    }

    formatDuration(from: moment.Moment, to?: moment.Moment): string {
        return DurationService.duration(from.toDate(), to ? to.toDate() : moment().toDate());
    }

    async clickExpandStepDown(index: number) {
        let step = this.steps[index];
        let result = await this._workflowService.getLogLines(step.link,
            { offset: `${step.lines[step.lines.length - 1].number + 1}`, limit: `${this.expandLoadLinesCount}` }
        ).toPromise()
        this.steps[index].totalLinesCount = result.totalCount;
        this.steps[index].lines = step.lines.concat(result.lines.filter(l => !step.endLines.find(line => line.number === l.number)));
        this._cd.markForCheck();
    }

    async clickExpandStepUp(index: number) {
        let step = this.steps[index];
        let result = await this._workflowService.getLogLines(step.link,
            { offset: `-${step.endLines.length + this.expandLoadLinesCount}`, limit: `${this.expandLoadLinesCount}` }
        ).toPromise();
        this.steps[index].totalLinesCount = result.totalCount;
        this.steps[index].endLines = result.lines.filter(l => {
            return !step.lines.find(line => line.number === l.number) && !step.endLines.find(line => line.number === l.number);
        }).concat(step.endLines);
        this._cd.markForCheck();
    }

    stopWebsocketSubscription(): void {
        if (this.websocketSubscription) {
            this.websocketSubscription.unsubscribe();
        }
    }

    async startListenLastActiveStep() {
        // Skip if only informations step exists
        if (this.steps.length <= 1) {
            return;
        }
        let lastStepStatus = this.nodeJobRun.job.step_status[this.nodeJobRun.job.step_status.length - 1];
        let action = this.nodeJobRun.job.action.actions[this.nodeJobRun.job.step_status.length - 1];
        if (!PipelineStatus.isActive(lastStepStatus.status) || !action.enabled) {
            return;
        }

        let projectKey = this._store.selectSnapshot(ProjectState.projectSnapshot).key;
        let workflowName = this._store.selectSnapshot(WorkflowState.workflowSnapshot).name;
        let nodeRunID = this._store.selectSnapshot(WorkflowState).workflowNodeRun.id;
        let nodeJobRunID = this._store.selectSnapshot(WorkflowState.getSelectedWorkflowNodeJobRun()).id;

        let link = await this._workflowService.getStepLink(projectKey, workflowName,
            nodeRunID, nodeJobRunID, this.nodeJobRun.job.step_status.length - 1).toPromise();
        let result = await this._workflowService.getLogLines(link, { limit: `${this.initLoadLinesCount}` }).toPromise();
        this.steps[this.steps.length - 1].link = link;
        this.steps[this.steps.length - 1].lines = result.lines;
        this.steps[this.steps.length - 1].totalLinesCount = result.totalCount;
        this.steps[this.steps.length - 1].open = true;
        this._cd.markForCheck();

        const protocol = window.location.protocol.replace('http', 'ws');
        const host = window.location.host;
        const href = this._router['location']._baseHref;

        this.websocket = webSocket({
            url: `${protocol}//${host}${href}/cdscdn/item/stream`,
            openObserver: {
                next: value => {
                    if (value.type === 'open') {
                        this.websocket.next(<CDNStreamFilter>{
                            item_type: link.item_type,
                            api_ref: link.api_ref,
                            offset: result.totalCount > 0 ? -5 : 0
                        });
                    }
                }
            }
        });

        this.websocketSubscription = this.websocket
            .pipe(retryWhen(errors => errors.pipe(delay(2000))))
            .subscribe((l: CDNLine) => {
                if (!this.steps[this.steps.length - 1].lines.find(line => line.number === l.number)
                    && !this.steps[this.steps.length - 1].endLines.find(line => line.number === l.number)) {
                    this.steps[this.steps.length - 1].endLines.push(l);
                    this.steps[this.steps.length - 1].totalLinesCount++;
                    this._cd.markForCheck();
                }
            }, (err) => {
                console.error('Error: ', err)
            }, () => {
                console.warn('Websocket Completed');
            });
    }

    async loadOrListenService() {
        let projectKey = this._store.selectSnapshot(ProjectState.projectSnapshot).key;
        let workflowName = this._store.selectSnapshot(WorkflowState.workflowSnapshot).name;
        let nodeRunID = this._store.selectSnapshot(WorkflowState).workflowNodeRun.id;
        let nodeJobRunID = this._store.selectSnapshot(WorkflowState.getSelectedWorkflowNodeJobRun()).id;

        this.services[this.currentTabIndex - 1].link = await this._workflowService.getServiceLink(projectKey, workflowName,
            nodeRunID, nodeJobRunID, this.services[this.currentTabIndex - 1].name).toPromise();

        if (!PipelineStatus.isActive(this.nodeJobRun.status)) {
            let results = await Promise.all([
                this._workflowService.getLogLines(this.services[this.currentTabIndex - 1].link,
                    { limit: `${this.initLoadLinesCount}` }
                ).toPromise(),
                this._workflowService.getLogLines(this.services[this.currentTabIndex - 1].link,
                    { offset: `-${this.initLoadLinesCount}` }
                ).toPromise(),
            ]);
            this.services[this.currentTabIndex - 1].lines = results[0].lines;
            this.services[this.currentTabIndex - 1].endLines = results[1].lines
                .filter(l => !results[0].lines.find(line => line.number === l.number));
            this.services[this.currentTabIndex - 1].totalLinesCount = results[0].totalCount;
            this._cd.markForCheck();
            return;
        }

        let result = await this._workflowService.getLogLines(this.services[this.currentTabIndex - 1].link,
            { limit: `${this.initLoadLinesCount}` }
        ).toPromise();
        this.services[this.currentTabIndex - 1].lines = result.lines;
        this.services[this.currentTabIndex - 1].totalLinesCount = result.totalCount;
        this._cd.markForCheck();

        const protocol = window.location.protocol.replace('http', 'ws');
        const host = window.location.host;
        const href = this._router['location']._baseHref;


        this.websocket = webSocket({
            url: `${protocol}//${host}${href}/cdscdn/item/stream`,
            openObserver: {
                next: value => {
                    if (value.type === 'open') {
                        this.websocket.next(<CDNStreamFilter>{
                            item_type: this.services[this.currentTabIndex - 1].link.item_type,
                            api_ref: this.services[this.currentTabIndex - 1].link.api_ref,
                            offset: this.services[this.currentTabIndex - 1].totalLinesCount > 0 ? -5 : 0
                        });
                    }
                }
            }
        });

        this.websocketSubscription = this.websocket
            .pipe(retryWhen(errors => errors.pipe(delay(2000))))
            .subscribe((l: CDNLine) => {
                if (!this.services[this.currentTabIndex - 1].lines.find(line => line.number === l.number)
                    && !this.services[this.currentTabIndex - 1].endLines.find(line => line.number === l.number)) {
                    this.services[this.currentTabIndex - 1].endLines.push(l);
                    this.services[this.currentTabIndex - 1].totalLinesCount++;
                    this._cd.markForCheck();
                }
            }, (err) => {
                console.error('Error: ', err)
            }, () => {
                console.warn('Websocket Completed');
            });
    }

    async clickExpandServiceDown(index: number) {
        let service = this.services[index];
        let result = await this._workflowService.getLogLines(service.link, {
            offset: `${service.lines[service.lines.length - 1].number + 1}`,
            limit: `${this.expandLoadLinesCount}`
        }).toPromise();
        this.services[index].totalLinesCount = result.totalCount;
        this.services[index].lines = service.lines.concat(result.lines
            .filter(l => !service.endLines.find(line => line.number === l.number)));
        this._cd.markForCheck();
    }

    async clickExpandServiceUp(index: number) {
        let service = this.services[index];
        let result = await this._workflowService.getLogLines(service.link, {
            offset: `-${service.endLines.length + this.expandLoadLinesCount}`,
            limit: `${this.expandLoadLinesCount}`
        }).toPromise();
        this.services[index].totalLinesCount = result.totalCount;
        this.services[index].endLines = result.lines.filter(l => {
            return !service.lines.find(line => line.number === l.number) && !service.endLines.find(line => line.number === l.number);
        }).concat(service.endLines);
        this._cd.markForCheck();
    }

    clickVariables(): void {
        if (this.jobVariable) {
            this.jobVariable.show();
        }
    }
}
