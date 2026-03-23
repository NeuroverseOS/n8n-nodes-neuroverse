import { IExecuteFunctions, ILoadOptionsFunctions, INodeExecutionData, INodePropertyOptions, INodeType, INodeTypeDescription } from 'n8n-workflow';
export declare class NeuroVerseGuard implements INodeType {
    description: INodeTypeDescription;
    methods: {
        loadOptions: {
            getCustomWorldChoices(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]>;
        };
    };
    execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]>;
}
//# sourceMappingURL=NeuroVerseGuard.node.d.ts.map