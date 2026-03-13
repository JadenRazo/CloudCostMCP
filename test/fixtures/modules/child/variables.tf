variable "instance_type" {
  description = "EC2 instance type for the child module server"
  type        = string
  default     = "t3.nano"
}

variable "ami" {
  description = "AMI ID for the child module server"
  type        = string
  default     = "ami-child456"
}
