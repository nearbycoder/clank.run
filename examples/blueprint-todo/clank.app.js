export default {
    name: "Orbit Tasks",
    slug: "orbit-tasks",
    description: "A collaborative Todoist-style planner with live tasks, roles, reminders, and deploy requirements.",
    auth: {
        required: true,
        organizations: true,
        roles: {
            owner: {
                description: "Owns workspace settings and membership.",
                permissions: [
                    "tasks.*",
                    "members.*",
                    "settings.*"
                ]
            },
            member: {
                description: "Creates and completes workspace tasks.",
                permissions: [
                    "tasks.read",
                    "tasks.write"
                ]
            }
        }
    },
    entities: {
        tasks: {
            description: "Actionable work belonging to a workspace.",
            ownership: "workspace",
            realtime: true,
            displayField: "title",
            completionField: "done",
            fields: {
                title: {
                    type: "string",
                    min: 1,
                    max: 200
                },
                done: {
                    type: "boolean",
                    default: false
                },
                priority: {
                    type: "enum",
                    values: [
                        "low",
                        "normal",
                        "high"
                    ],
                    default: "normal"
                },
                dueOn: {
                    type: "date",
                    required: false,
                    nullable: true,
                    default: null
                }
            },
            indexes: {
                by_done: {
                    fields: [
                        "done"
                    ]
                },
                by_priority: {
                    fields: [
                        "priority"
                    ]
                }
            }
        }
    },
    relationships: [],
    routes: [
        {
            path: "/",
            view: "TaskInbox",
            entity: "tasks",
            access: {
                roles: [
                    "owner",
                    "member"
                ]
            }
        }
    ],
    actions: {
        "tasks.create": {
            description: "Create a task in the active workspace.",
            entity: "tasks",
            operation: "create",
            roles: [
                "owner",
                "member"
            ]
        },
        "tasks.complete": {
            description: "Complete or reopen a task.",
            entity: "tasks",
            operation: "update",
            roles: [
                "owner",
                "member"
            ],
            realtime: true
        },
        "tasks.delete": {
            description: "Permanently delete a task.",
            entity: "tasks",
            operation: "delete",
            roles: [
                "owner"
            ],
            confirmation: "always"
        }
    },
    services: {
        reminders: {
            kind: "jobs",
            description: "Schedule durable task reminders.",
            required: true,
            capabilities: [
                "delayed",
                "retry"
            ]
        },
        mail: {
            kind: "email",
            description: "Deliver invitations and reminder notifications.",
            required: true,
            capabilities: [
                "transactional"
            ]
        }
    },
    deployment: {
        database: "sqlite",
        scale: "single",
        isolation: "container",
        healthPath: "/healthz",
        customDomains: true
    }
};


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi9ob21lL25lYXJieS9TaXRlcy9jbGFuay9leGFtcGxlcy9ibHVlcHJpbnQtdG9kby9jbGFuay5hcHAudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsZUFBZTtJQUNiLE1BQU07SUFDTixNQUFNO0lBQ04sYUFBYTtJQUNiLE1BQU07UUFDSixVQUFVO1FBQ1YsZUFBZTtRQUNmLE9BQU87WUFDTCxPQUFPO2dCQUNMLGFBQWE7Z0JBQ2IsYUFBYTtvQkFBQztvQkFBVztvQkFBYTtpQkFBYTtZQUNyRDtZQUNBLFFBQVE7Z0JBQ04sYUFBYTtnQkFDYixhQUFhO29CQUFDO29CQUFjO2lCQUFjO1lBQzVDO1FBQ0Y7SUFDRjtJQUNBLFVBQVU7UUFDUixPQUFPO1lBQ0wsYUFBYTtZQUNiLFdBQVc7WUFDWCxVQUFVO1lBQ1YsY0FBYztZQUNkLGlCQUFpQjtZQUNqQixRQUFRO2dCQUNOLE9BQU87b0JBQUUsTUFBTTtvQkFBVSxLQUFLO29CQUFHLEtBQUs7Z0JBQUk7Z0JBQzFDLE1BQU07b0JBQUUsTUFBTTtvQkFBVyxTQUFTO2dCQUFNO2dCQUN4QyxVQUFVO29CQUNSLE1BQU07b0JBQ04sUUFBUTt3QkFBQzt3QkFBTzt3QkFBVTtxQkFBTztvQkFDakMsU0FBUztnQkFDWDtnQkFDQSxPQUFPO29CQUNMLE1BQU07b0JBQ04sVUFBVTtvQkFDVixVQUFVO29CQUNWLFNBQVM7Z0JBQ1g7WUFDRjtZQUNBLFNBQVM7Z0JBQ1AsU0FBUztvQkFBRSxRQUFRO3dCQUFDO3FCQUFPO2dCQUFDO2dCQUM1QixhQUFhO29CQUFFLFFBQVE7d0JBQUM7cUJBQVc7Z0JBQUM7WUFDdEM7UUFDRjtJQUNGO0lBQ0EsZUFBZSxFQUFFO0lBQ2pCLFFBQVE7UUFDTjtZQUNFLE1BQU07WUFDTixNQUFNO1lBQ04sUUFBUTtZQUNSLFFBQVE7Z0JBQUUsT0FBTztvQkFBQztvQkFBUztpQkFBUztZQUFDO1FBQ3ZDO0tBQ0Q7SUFDRCxTQUFTO1FBQ1AsZ0JBQWdCO1lBQ2QsYUFBYTtZQUNiLFFBQVE7WUFDUixXQUFXO1lBQ1gsT0FBTztnQkFBQztnQkFBUzthQUFTO1FBQzVCO1FBQ0Esa0JBQWtCO1lBQ2hCLGFBQWE7WUFDYixRQUFRO1lBQ1IsV0FBVztZQUNYLE9BQU87Z0JBQUM7Z0JBQVM7YUFBUztZQUMxQixVQUFVO1FBQ1o7UUFDQSxnQkFBZ0I7WUFDZCxhQUFhO1lBQ2IsUUFBUTtZQUNSLFdBQVc7WUFDWCxPQUFPO2dCQUFDO2FBQVE7WUFDaEIsY0FBYztRQUNoQjtJQUNGO0lBQ0EsVUFBVTtRQUNSLFdBQVc7WUFDVCxNQUFNO1lBQ04sYUFBYTtZQUNiLFVBQVU7WUFDVixjQUFjO2dCQUFDO2dCQUFXO2FBQVE7UUFDcEM7UUFDQSxNQUFNO1lBQ0osTUFBTTtZQUNOLGFBQWE7WUFDYixVQUFVO1lBQ1YsY0FBYztnQkFBQzthQUFnQjtRQUNqQztJQUNGO0lBQ0EsWUFBWTtRQUNWLFVBQVU7UUFDVixPQUFPO1FBQ1AsV0FBVztRQUNYLFlBQVk7UUFDWixlQUFlO0lBQ2pCO0FBQ0YsRUFBNEQifQ==